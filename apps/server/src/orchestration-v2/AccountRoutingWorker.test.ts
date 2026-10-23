import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { accountRoutingCommands } from "./AccountRoutingWorker.ts";
import type { ProjectionAccountRoutingCandidate } from "./ProjectionStore.ts";

const nowMs = Date.parse("2026-10-23T12:00:00.000Z");
const limitedId = ProviderInstanceId.make("codex");

function provider(id: string, overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("codex"),
    continuation: { groupKey: "codex:home:/home/me/.codex" },
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: `${id}@example.com` },
    checkedAt: "2026-10-23T11:00:00.000Z",
    models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: "2026-10-23T11:00:00.000Z",
      windows: [
        {
          id: "primary",
          kind: "session",
          label: "Session",
          usedPercent: 20,
          resetsAt: "2026-10-23T14:00:00.000Z",
        },
      ],
    },
    ...overrides,
  } as ServerProvider;
}

function usage(usedPercent: number, resetsAt = "2026-10-23T14:00:00.000Z") {
  return {
    usageLimits: {
      checkedAt: "2026-10-23T11:00:00.000Z",
      windows: [
        { id: "primary", kind: "session" as const, label: "Session", usedPercent, resetsAt },
      ],
    },
  };
}

function candidate(
  overrides: Partial<ProjectionAccountRoutingCandidate> = {},
): ProjectionAccountRoutingCandidate {
  return {
    threadId: ThreadId.make("thread:limited"),
    projectId: ProjectId.make("project:limited"),
    modelSelection: { instanceId: limitedId, model: "gpt-5.4" },
    runId: RunId.make("run:limited"),
    runProviderInstanceId: limitedId,
    completedAt: DateTime.makeUnsafe(nowMs - 60_000),
    resetAt: "2026-10-23T15:00:00.000Z",
    limitRecovery: null,
    snoozedUntil: null,
    queuedRuns: [],
    ...overrides,
  };
}

function route(
  providers: ReadonlyArray<ServerProvider>,
  overrides: Partial<ProjectionAccountRoutingCandidate> = {},
) {
  return accountRoutingCommands({
    candidate: candidate(overrides),
    providers,
    // Unconfigured instances other than the default one count as disabled.
    settings: {
      providerInstances: Object.fromEntries(
        providers.map((entry) => [entry.instanceId, { driver: entry.driver }]),
      ),
      projectSettingsOverrides: {},
    },
    nowMs,
  });
}

function routedInstance(
  providers: ReadonlyArray<ServerProvider>,
  overrides: Partial<ProjectionAccountRoutingCandidate> = {},
) {
  const [command] = route(providers, overrides);
  return command?.type === "message.dispatch" ? command.modelSelection?.instanceId : undefined;
}

const limited = provider("codex", usage(100));

describe("accountRoutingCommands", () => {
  it("continues on the compatible account with the most quota left", () => {
    expect(
      routedInstance([limited, provider("work", usage(70)), provider("personal", usage(30))]),
    ).toBe("personal");
  });

  it("treats a window whose reset has passed as refilled", () => {
    expect(
      routedInstance([
        limited,
        provider("stale", usage(100, "2026-10-23T11:30:00.000Z")),
        provider("fresh", usage(50)),
      ]),
    ).toBe("stale");
  });

  it("skips accounts that cannot take the thread", () => {
    expect(
      route([
        limited,
        provider("other-home", { continuation: { groupKey: "codex:home:/elsewhere" } }),
        provider("signed-out", { auth: { status: "unauthenticated" } }),
        provider("no-model", { models: [] }),
        provider("exhausted", usage(100)),
        provider("api-key", {
          usageLimits: {
            checkedAt: "2026-10-23T11:00:00.000Z",
            windows: [],
            unavailable: { reason: "unsupported" },
          },
        }),
        provider("same-login", { auth: { status: "authenticated", email: "codex@example.com" } }),
        provider("disabled", { enabled: false }),
      ]),
    ).toEqual([]);
  });

  it("leaves threads alone when the user chose otherwise or the limit has passed", () => {
    const providers = [limited, provider("work")];
    // The user picked another account after the limit.
    expect(
      route(providers, {
        modelSelection: { instanceId: ProviderInstanceId.make("work"), model: "gpt-5.4" },
      }),
    ).toEqual([]);
    // The reset already happened, so this is an old thread rather than a waiting one.
    expect(route(providers, { resetAt: "2026-10-23T11:00:00.000Z" })).toEqual([]);
    // Without a reset time, only a recent limit counts as still waiting.
    expect(route(providers, { resetAt: null })).toHaveLength(1);
    expect(
      route(providers, { resetAt: null, completedAt: DateTime.makeUnsafe(nowMs - 6 * 3_600_000) }),
    ).toEqual([]);
    // Stopping the thread disarmed its recovery.
    expect(
      route(providers, {
        limitRecovery: {
          runId: RunId.make("run:limited"),
          resetAt: "2026-10-23T15:00:00.000Z",
          autoResume: false,
          snooze: false,
        },
      }),
    ).toEqual([]);
    // A snooze the user chose keeps the thread asleep; the automatic one until the reset does not.
    const snoozedUntil = DateTime.makeUnsafe(nowMs + 3_600_000);
    expect(route(providers, { snoozedUntil })).toEqual([]);
    expect(
      route(providers, {
        snoozedUntil,
        limitRecovery: {
          runId: RunId.make("run:limited"),
          resetAt: "2026-10-23T15:00:00.000Z",
          autoResume: false,
          snooze: true,
        },
      }),
    ).toHaveLength(1);
  });

  it("requires queued models on the target and resumes a held queue", () => {
    const providers = [limited, provider("work")];
    expect(
      route(providers, {
        queuedRuns: [
          { modelSelection: { instanceId: limitedId, model: "gpt-5.5" }, queueHeld: true },
        ],
      }),
    ).toEqual([]);
    expect(
      route(providers, {
        queuedRuns: [
          { modelSelection: { instanceId: limitedId, model: "gpt-5.4" }, queueHeld: true },
        ],
      }).map((command) => command.type),
    ).toEqual(["message.dispatch", "queue.resume"]);
  });
});
