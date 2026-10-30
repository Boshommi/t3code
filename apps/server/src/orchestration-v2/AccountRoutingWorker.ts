import {
  CommandId,
  MessageId,
  isProviderAvailable,
  resolveProjectProviderInstanceEnabled,
  type OrchestrationV2Command,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import { tightestLimitWindow } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

function accountIdentity(provider: ServerProvider): string | null {
  const email = provider.auth.email?.trim().toLowerCase();
  if (email) return `email:${email}`;
  const fingerprint = provider.usageLimits?.credentialFingerprint;
  return fingerprint ? `credential:${fingerprint}` : null;
}

/**
 * Picks the account with the most quota left among the ones that can resume
 * the thread's native conversation. Returns null when none has quota.
 */
export function pickRoutingAccount(input: {
  readonly limitedInstanceId: ProviderInstanceId;
  readonly models: ReadonlyArray<string>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly blockedUntil: ReadonlyMap<ProviderInstanceId, number>;
  readonly isEnabledForProject: (instanceId: ProviderInstanceId) => boolean;
  readonly nowMs: number;
}): ServerProvider | null {
  const limited = input.providers.find(
    (provider) => provider.instanceId === input.limitedInstanceId,
  );
  const groupKey = limited?.continuation?.groupKey;
  if (limited === undefined || groupKey === undefined) return null;
  const limitedAccount = accountIdentity(limited);
  let best: { readonly provider: ServerProvider; readonly left: number } | null = null;
  for (const provider of input.providers) {
    if (
      provider.instanceId === limited.instanceId ||
      provider.driver !== limited.driver ||
      provider.continuation?.groupKey !== groupKey ||
      !provider.enabled ||
      !provider.installed ||
      provider.status === "error" ||
      provider.status === "disabled" ||
      provider.auth.status !== "authenticated" ||
      !isProviderAvailable(provider) ||
      !input.isEnabledForProject(provider.instanceId) ||
      // A second instance signed in to the same login shares its limits.
      (limitedAccount !== null && accountIdentity(provider) === limitedAccount) ||
      !input.models.every((model) => provider.models.some((candidate) => candidate.slug === model))
    ) {
      continue;
    }
    const identity = accountIdentity(provider);
    if (
      input.providers.some(
        (account) =>
          (account.instanceId === provider.instanceId ||
            (identity !== null &&
              account.driver === provider.driver &&
              accountIdentity(account) === identity)) &&
          (input.blockedUntil.get(account.instanceId) ?? 0) > input.nowMs,
      )
    )
      continue;
    // Accounts without a reading may bill per request or be limited without us knowing.
    const left = tightestLimitWindow(provider.usageLimits, input.nowMs)?.remaining;
    if (left === undefined || left <= 0) continue;
    if (best === null || left > best.left) best = { provider, left };
  }
  return best?.provider ?? null;
}

export function accountRoutingCommands(input: {
  readonly candidate: ProjectionStore.ProjectionAccountRoutingCandidate;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly blockedUntil: ReadonlyMap<ProviderInstanceId, number>;
  readonly settings: Pick<ServerSettingsValue, "providerInstances" | "projectSettingsOverrides">;
  readonly nowMs: number;
}): ReadonlyArray<OrchestrationV2Command> {
  const { candidate, nowMs } = input;
  const limitedInstanceId = candidate.runProviderInstanceId;
  // The user already picked another account for this thread.
  if (candidate.modelSelection.instanceId !== limitedInstanceId) return [];
  const resetMs = candidate.resetAt === null ? Number.NaN : Date.parse(candidate.resetAt);
  const completedMs =
    candidate.completedAt === null ? Number.NaN : DateTime.toEpochMillis(candidate.completedAt);
  const stillWaiting = Number.isFinite(resetMs)
    ? resetMs > nowMs
    : Number.isFinite(completedMs) &&
      completedMs + ProjectionStore.UNKNOWN_USAGE_LIMIT_RESET_MS > nowMs;
  if (!stillWaiting) return [];
  const recovery = candidate.limitRecovery;
  const recoveryForRun = recovery?.runId === candidate.runId ? recovery : null;
  // Stopping a limited thread disarms its recovery; respect that here too.
  if (recoveryForRun !== null && !recoveryForRun.autoResume && recoveryForRun.snooze !== true) {
    return [];
  }
  // A snooze the user chose, rather than the automatic one until the reset, keeps the thread asleep.
  if (
    candidate.snoozedUntil !== null &&
    DateTime.toEpochMillis(candidate.snoozedUntil) > nowMs &&
    recoveryForRun?.snooze !== true
  ) {
    return [];
  }
  const target = pickRoutingAccount({
    limitedInstanceId,
    models: [
      ...new Set([
        candidate.modelSelection.model,
        ...candidate.queuedRuns
          .filter((run) => run.modelSelection.instanceId === limitedInstanceId)
          .map((run) => run.modelSelection.model),
      ]),
    ],
    providers: input.providers,
    blockedUntil: input.blockedUntil,
    isEnabledForProject: (instanceId) =>
      resolveProjectProviderInstanceEnabled(input.settings, candidate.projectId, instanceId),
    nowMs,
  });
  if (target === null) return [];
  // One attempt per limited run and account: a rejected switch is not retried
  // on the same account, but another account can still take the thread.
  const identity = `${candidate.threadId}:${candidate.runId}:${target.instanceId}`;
  const continuation: OrchestrationV2Command = {
    type: "message.dispatch",
    commandId: CommandId.make(`account-route:${identity}`),
    messageId: MessageId.make(`account-route:${identity}`),
    threadId: candidate.threadId,
    manualContinuationOfRunId: candidate.runId,
    modelSelection: { ...candidate.modelSelection, instanceId: target.instanceId },
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
  if (!candidate.queuedRuns.some((run) => run.queueHeld)) return [continuation];
  return [
    continuation,
    {
      type: "queue.resume",
      commandId: CommandId.make(`account-route-queue:${identity}`),
      threadId: candidate.threadId,
    },
  ];
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  return Effect.fn("AccountRoutingWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    if (!preferences.switchLimitedAccounts) return;
    const candidates = yield* projections.getAccountRoutingCandidates();
    if (candidates.length === 0) return;
    const snapshot = yield* providers.getProviders;
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const blockedUntil = yield* projections.getAccountUsageLimitResetTimes(now);
    for (const candidate of candidates) {
      const commands = accountRoutingCommands({
        candidate,
        providers: snapshot,
        blockedUntil,
        settings: preferences,
        nowMs,
      });
      yield* Effect.forEach(commands, (command) => threads.dispatch(command), {
        discard: true,
      }).pipe(
        // Command ids are stable per limited run and account, so a rejected switch repeats its first answer.
        Effect.catchTags({ OrchestratorCommandPreviouslyRejectedError: () => Effect.void }),
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.account-routing.dispatch-failed", {
            threadId: candidate.threadId,
            cause,
          }),
        ),
      );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("account-routing", sweep());
  }),
);
