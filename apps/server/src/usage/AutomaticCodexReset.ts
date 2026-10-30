import type {
  ProviderConsumeResetCreditOutcome,
  ServerProviderUsageLimits,
  UsageLimitSourceError,
} from "@t3tools/contracts";
import type { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ProviderInstances from "../provider/ProviderInstanceRegistry.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as Sources from "./UsageLimitSources.ts";

export class AutomaticCodexReset extends Context.Service<
  AutomaticCodexReset,
  {
    readonly sweep: Effect.Effect<void>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/usage/AutomaticCodexReset") {}

interface Account {
  readonly email?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly fallback: string;
  readonly limits: ServerProviderUsageLimits | undefined;
  readonly consume:
    | (() => Effect.Effect<
        ProviderConsumeResetCreditOutcome,
        ProviderDriverError | UsageLimitSourceError
      >)
    | undefined;
}

const make = Effect.gen(function* () {
  const instances = yield* ProviderInstances.ProviderInstanceRegistry;
  const providers = yield* Providers.ProviderRegistry;
  const sources = yield* Sources.UsageLimitSources;
  const settings = yield* Settings.ServerSettingsService;
  const lock = yield* Semaphore.make(1);
  // A failed confirmation can leave the old windows published. Rearm only
  // after a newer reading confirms that the account recovered.
  const attempted = new Map<string, number>();

  const consider = Effect.fn("AutomaticCodexReset.consider")(function* (
    key: string,
    limits: ServerProviderUsageLimits | undefined,
    consume: Account["consume"],
  ) {
    if (!limits || limits.unavailable) return;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const windows = limits.windows.filter(
      (window) =>
        (window.id === "primary" || window.id === "secondary") &&
        (window.kind === "session" || window.kind === "weekly") &&
        (!window.resetsAt || Date.parse(window.resetsAt) > now),
    );
    if (windows.length === 0) return;
    if (windows.every((window) => window.usedPercent < 98)) {
      const previous = attempted.get(key);
      if (previous !== undefined && Date.parse(limits.checkedAt) > previous) attempted.delete(key);
      return;
    }
    const credits = limits.resetCredits;
    if (
      attempted.has(key) ||
      !consume ||
      !credits ||
      credits.availableCount === 0 ||
      (credits.nextExpiresAt !== undefined && Date.parse(credits.nextExpiresAt) <= now)
    )
      return;
    // Claim before I/O so duplicate accounts and subsequent notifications
    // cannot spend another credit while the first reset is unconfirmed.
    attempted.set(key, Math.max(now, Date.parse(limits.checkedAt)));
    yield* consume().pipe(
      Effect.catchCause((cause) => Effect.logWarning("Automatic Codex reset failed", { cause })),
    );
  });

  const sweep = Effect.fn("AutomaticCodexReset.sweep")(
    function* () {
      const preferences = yield* settings.getSettings;
      if (!preferences.autoResetCodexUsage) return;
      const accounts: Account[] = [];
      for (const instance of yield* instances.listInstances) {
        if (!instance.enabled || instance.driverKind !== "codex" || !instance.consumeResetCredit)
          continue;
        const snapshot = yield* instance.snapshot.getSnapshot;
        if (!snapshot.enabled || snapshot.auth.status !== "authenticated") continue;
        accounts.push({
          ...snapshot.auth,
          fallback: `instance:${instance.instanceId}`,
          limits: snapshot.usageLimits,
          consume: instance.consumeResetCredit,
        });
      }
      for (const source of yield* sources.current) {
        if (source.error || !preferences.usageLimitSources[source.id]?.enabled) continue;
        for (const account of source.accounts) {
          if (account.driver !== "codex") continue;
          const creditId = account.usageLimits.resetCredits?.nextCreditId;
          accounts.push({
            ...account,
            fallback: `source:${source.id}:${account.id}`,
            limits: account.usageLimits,
            consume: creditId
              ? () =>
                  sources
                    .consumeResetCredit({ sourceId: source.id, accountId: account.id, creditId })
                    .pipe(Effect.map((result) => result.outcome))
              : undefined,
          });
        }
      }
      const workspaces = new Map<string, Set<string>>();
      for (const account of accounts) {
        const email = account.email?.trim().toLowerCase();
        if (email && account.workspaceId) {
          workspaces.set(email, (workspaces.get(email) ?? new Set()).add(account.workspaceId));
        }
      }
      const seen = new Set<string>();
      // Only the latest reading of an account can rearm it or trigger a reset;
      // an older hub/instance must not undo a freshly confirmed recovery.
      accounts.sort(
        (a, b) => Date.parse(b.limits?.checkedAt ?? "") - Date.parse(a.limits?.checkedAt ?? ""),
      );
      for (const account of accounts) {
        if (!account.limits || account.limits.unavailable) continue;
        const email = account.email?.trim().toLowerCase();
        const known = email ? workspaces.get(email) : undefined;
        const workspace = account.workspaceId ?? (known?.size === 1 ? [...known][0] : undefined);
        if (!workspace && known && known.size > 1) continue;
        const key =
          email || workspace
            ? `account:${encodeURIComponent(email ?? "")}:${encodeURIComponent(workspace ?? "")}`
            : account.fallback;
        if (seen.has(key)) continue;
        seen.add(key);
        yield* consider(key, account.limits, account.consume);
      }
    },
    lock.withPermits(1),
    Effect.ignoreCause({ log: true }),
  );

  const start = Effect.gen(function* () {
    yield* Stream.mergeAll(
      [
        Stream.make(undefined),
        providers.streamChanges.pipe(Stream.as(undefined)),
        sources.streamChanges.pipe(Stream.as(undefined)),
        settings.streamChanges.pipe(
          Stream.map((value) => value.autoResetCodexUsage),
          Stream.changes,
          Stream.as(undefined),
        ),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Stream.runForEach(() => sweep()),
      Effect.forkScoped,
    );
  });

  return { sweep: sweep(), start } satisfies AutomaticCodexReset["Service"];
});

export const layer = Layer.effect(AutomaticCodexReset, make);
