import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  UsageLimitSourceError,
  type ServerProviderUsageLimits,
  type ServerProvider,
  type UsageLimitSourceAccount,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ProviderInstances from "../provider/ProviderInstanceRegistry.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as AutomaticCodexReset from "./AutomaticCodexReset.ts";
import * as Sources from "./UsageLimitSources.ts";

const sourceId = UsageLimitSourceId.make("hub");
const limits = (
  usedPercent: number,
  overrides: Partial<ServerProviderUsageLimits> = {},
): ServerProviderUsageLimits => ({
  checkedAt: "1970-01-01T00:00:00.000Z",
  windows: [{ id: "primary", kind: "session", label: "Session", usedPercent }],
  resetCredits: { availableCount: 2, nextCreditId: "credit-1" },
  ...overrides,
});

const account = (usageLimits: ServerProviderUsageLimits): UsageLimitSourceAccount => ({
  id: "account",
  email: "user@example.test",
  driver: ProviderDriverKind.make("codex"),
  usageLimits,
});

const provider = (
  usageLimits: ServerProviderUsageLimits,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated", email: "USER@example.test", workspaceId: "workspace" },
  checkedAt: usageLimits.checkedAt,
  version: null,
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits,
  ...overrides,
});

const setup = Effect.gen(function* () {
  let accounts: UsageLimitSourceAccount[] = [];
  let local: ProviderInstance[] = [];
  const calls: string[] = [];
  let fail = false;
  const consumed = yield* Deferred.make<void>();
  const changes = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
  const settingsLayer = Settings.layerTest({
    autoResetCodexUsage: true,
    usageLimitSources: {
      [sourceId]: {
        kind: "cliproxy",
        url: "https://hub.test",
        managementKey: "test",
        enabled: true,
      },
    },
  });
  const dependencies = Layer.mergeAll(
    settingsLayer,
    Layer.mock(ProviderInstances.ProviderInstanceRegistry)({
      listInstances: Effect.sync(() => local),
    }),
    Layer.mock(Providers.ProviderRegistry)({ streamChanges: Stream.fromQueue(changes) }),
    Layer.mock(Sources.UsageLimitSources)({
      current: Effect.sync(() => [
        {
          id: sourceId,
          kind: "cliproxy" as const,
          label: "Hub",
          checkedAt: "1970-01-01T00:00:00.000Z",
          accounts,
        },
      ]),
      streamChanges: Stream.empty,
      consumeResetCredit: (input) =>
        Effect.gen(function* () {
          calls.push(input.creditId);
          yield* Deferred.succeed(consumed, undefined);
          if (fail) return yield* new UsageLimitSourceError({ detail: "Unconfirmed reset" });
          return { outcome: "reset" as const };
        }),
    }),
  );
  const context = yield* Layer.build(
    AutomaticCodexReset.layer.pipe(Layer.provideMerge(dependencies)),
  );
  return {
    resets: Context.get(context, AutomaticCodexReset.AutomaticCodexReset),
    settings: Context.get(context, Settings.ServerSettingsService),
    calls,
    changes,
    consumed,
    setAccounts: (next: UsageLimitSourceAccount[]) => {
      accounts = next;
    },
    fail: () => {
      fail = true;
    },
    addLocal: (snapshot: ServerProvider) => {
      const unused = () => Effect.die("Unexpected provider operation");
      local.push({
        instanceId: snapshot.instanceId,
        driverKind: snapshot.driver,
        enabled: snapshot.enabled,
        displayName: undefined,
        continuationIdentity: { driverKind: snapshot.driver, continuationKey: "test" },
        snapshot: {
          getSnapshot: Effect.succeed(snapshot),
          refresh: unused(),
          streamChanges: Stream.empty,
          applyUsageLimits: unused,
          resolveMaintenance: unused,
        },
        orchestrationAdapter: {
          instanceId: snapshot.instanceId,
          driver: snapshot.driver,
          getCapabilities: unused,
          planSelectionTransition: unused,
          openSession: unused,
        },
        textGeneration: {
          generateCommitMessage: unused,
          generatePrContent: unused,
          generateBranchName: unused,
          generateThreadTitle: unused,
          generateReviewGuide: unused,
        },
        consumeResetCredit: () =>
          Effect.sync(() => {
            calls.push("local");
            return "reset" as const;
          }),
      });
    },
  };
});

it.effect.each([98, 99, 100])("redeems one banked credit at %s%% used", (percent) =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    fixture.setAccounts([account(limits(percent))]);
    yield* fixture.resets.sweep;
    yield* fixture.resets.sweep;
    expect(fixture.calls).toEqual(["credit-1"]);
  }).pipe(Effect.scoped),
);

it.effect("ignores healthy, unavailable, expired and unresettable limits", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const snapshots = [
      limits(97.99),
      limits(100, { resetCredits: { availableCount: 0 } }),
      limits(100, { resetCredits: undefined }),
      limits(100, { resetCredits: { availableCount: 2 } }),
      limits(100, {
        resetCredits: {
          availableCount: 2,
          nextCreditId: "expired",
          nextExpiresAt: "1970-01-01T00:00:00.000Z",
        },
      }),
      limits(100, { unavailable: { reason: "probeFailed" } }),
      limits(100, { windows: [] }),
      limits(100, {
        windows: [
          {
            id: "primary",
            kind: "session",
            label: "Session",
            usedPercent: 100,
            resetsAt: "1970-01-01T00:00:00.000Z",
          },
        ],
      }),
      limits(100, {
        windows: [{ id: "individual", kind: "monthly", label: "Spend limit", usedPercent: 100 }],
      }),
      limits(100, {
        windows: [{ id: "primary", kind: "monthly", label: "Monthly", usedPercent: 100 }],
      }),
    ];
    for (const snapshot of snapshots) {
      fixture.setAccounts([account(snapshot)]);
      yield* fixture.resets.sweep;
    }
    expect(fixture.calls).toEqual([]);
    fixture.setAccounts([
      { ...account(limits(100)), driver: ProviderDriverKind.make("claudeAgent") },
    ]);
    yield* fixture.resets.sweep;
    expect(fixture.calls).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("is opt-in and stops when the setting or source is disabled", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    fixture.setAccounts([account(limits(100))]);
    yield* fixture.settings.updateSettings({ autoResetCodexUsage: false });
    yield* fixture.resets.sweep;
    yield* fixture.settings.updateSettings({
      autoResetCodexUsage: true,
      usageLimitSources: {
        [sourceId]: {
          ...(yield* fixture.settings.getSettings).usageLimitSources[sourceId]!,
          enabled: false,
        },
      },
    });
    yield* fixture.resets.sweep;
    expect(fixture.calls).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("resets when the weekly allowance reaches the threshold", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    fixture.setAccounts([
      account(
        limits(0, {
          windows: [
            { id: "primary", kind: "session", label: "Session", usedPercent: 10 },
            { id: "secondary", kind: "weekly", label: "Weekly", usedPercent: 98 },
          ],
        }),
      ),
    ]);
    yield* fixture.resets.sweep;
    expect(fixture.calls).toEqual(["credit-1"]);
  }).pipe(Effect.scoped),
);

it.effect("requires a newer healthy reading before spending another credit", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    fixture.setAccounts([account(limits(98))]);
    yield* fixture.resets.sweep;
    fixture.setAccounts([account(limits(0))]);
    yield* fixture.resets.sweep;
    fixture.setAccounts([account(limits(100))]);
    yield* fixture.resets.sweep;
    expect(fixture.calls).toEqual(["credit-1"]);
    fixture.setAccounts([account(limits(0, { checkedAt: "1970-01-01T00:01:00.000Z" }))]);
    yield* fixture.resets.sweep;
    fixture.setAccounts([
      account(
        limits(98, {
          checkedAt: "1970-01-01T00:02:00.000Z",
          resetCredits: { availableCount: 1, nextCreditId: "credit-2" },
        }),
      ),
    ]);
    yield* fixture.resets.sweep;
    expect(fixture.calls).toEqual(["credit-1", "credit-2"]);
  }).pipe(Effect.scoped),
);

it.effect("does not retry unconfirmed resets on repeated or concurrent readings", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    fixture.fail();
    fixture.setAccounts([account(limits(100))]);
    yield* Effect.all([fixture.resets.sweep, fixture.resets.sweep], { concurrency: "unbounded" });
    fixture.setAccounts([account(limits(100, { checkedAt: "1970-01-01T00:01:00.000Z" }))]);
    yield* fixture.resets.sweep;
    expect(fixture.calls).toEqual(["credit-1"]);
  }).pipe(Effect.scoped),
);

it.effect("responds to usage notifications without an open client", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* fixture.resets.start;
    fixture.setAccounts([account(limits(98))]);
    yield* Queue.offer(fixture.changes, []);
    yield* Deferred.await(fixture.consumed);
    expect(fixture.calls).toEqual(["credit-1"]);
  }).pipe(Effect.scoped),
);

it.effect("redeems local Codex credits and deduplicates matching hub accounts", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    fixture.addLocal(provider(limits(98)));
    fixture.addLocal(provider(limits(100), { instanceId: ProviderInstanceId.make("same-login") }));
    fixture.setAccounts([account(limits(100))]);
    yield* fixture.resets.sweep;
    yield* fixture.resets.sweep;
    expect(fixture.calls).toEqual(["local"]);
  }).pipe(Effect.scoped),
);

it.effect("uses the newest account reading across instances and hubs", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    fixture.addLocal(provider(limits(98)));
    fixture.setAccounts([account(limits(0, { checkedAt: "1970-01-01T00:01:00.000Z" }))]);
    yield* fixture.resets.sweep;
    expect(fixture.calls).toEqual([]);
    fixture.setAccounts([account(limits(98, { checkedAt: "1970-01-01T00:02:00.000Z" }))]);
    yield* fixture.resets.sweep;
    expect(fixture.calls).toEqual(["credit-1"]);
  }).pipe(Effect.scoped),
);

it.effect("keeps different workspaces separate and skips disabled or signed-out instances", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    fixture.addLocal(provider(limits(98), { enabled: false }));
    fixture.addLocal(provider(limits(98), { auth: { status: "unauthenticated" } }));
    fixture.addLocal(provider(limits(98)));
    fixture.setAccounts([{ ...account(limits(98)), workspaceId: "another-workspace" }]);
    yield* fixture.resets.sweep;
    expect(fixture.calls).toEqual(["local", "credit-1"]);
  }).pipe(Effect.scoped),
);
