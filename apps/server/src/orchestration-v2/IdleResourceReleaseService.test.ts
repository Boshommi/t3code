import {
  type OrchestrationV2ThreadShell,
  type PreviewSessionSnapshot,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  type TerminalSummary,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import * as PreviewManager from "../preview/Manager.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as IdleResourceReleaseService from "./IdleResourceReleaseService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const NOW = "2026-10-01T00:10:00.000Z";
const QUIET_AT = "2026-10-01T00:00:00.000Z";
const RECENT_AT = "2026-10-01T00:08:00.000Z";
const CUTOFF_MS = Date.parse(NOW) - IdleResourceReleaseService.IDLE_RELEASE_AFTER_MS;

const threadShell = (
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: id,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: DateTime.makeUnsafe(QUIET_AT),
    updatedAt: DateTime.makeUnsafe(QUIET_AT),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
};

const terminal = (threadId: string, overrides: Partial<TerminalSummary> = {}): TerminalSummary => ({
  threadId,
  terminalId: "default",
  cwd: "/workspace",
  worktreePath: null,
  status: "running",
  pid: 100,
  exitCode: null,
  exitSignal: null,
  hasRunningSubprocess: false,
  label: "zsh",
  updatedAt: QUIET_AT,
  ...overrides,
});

const tab = (
  threadId: string,
  tabId: string,
  overrides: Partial<PreviewSessionSnapshot> = {},
): PreviewSessionSnapshot => ({
  threadId,
  tabId,
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  runtime: "desktop",
  updatedAt: QUIET_AT,
  ...overrides,
});

describe("IdleResourceReleaseService", () => {
  it.effect("releases quiet shells and desktop tabs of idle threads only", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const threads = new Map(
        [
          threadShell("idle"),
          threadShell("running", { activeRunId: RunId.make("run-1") }),
          threadShell("recently-active", {
            latestRunCompletedAt: DateTime.makeUnsafe(RECENT_AT),
          }),
          threadShell("command-only"),
        ].map((thread) => [thread.id as string, thread]),
      );
      const threadReads = yield* Ref.make<ReadonlyArray<string>>([]);
      const closedIdle = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const closedTabs = yield* Ref.make<ReadonlyArray<string>>([]);

      const layer = Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: (threadId) =>
            Ref.update(threadReads, (reads) => [...reads, threadId]).pipe(
              Effect.as(threads.get(threadId) ?? null),
            ),
        }),
        Layer.mock(TerminalManager.TerminalManager)({
          list: () =>
            Effect.succeed([
              terminal("idle"),
              terminal("running"),
              terminal("recently-active"),
              terminal("command-only", { hasRunningSubprocess: true }),
            ]),
          closeIdle: (input) => Ref.update(closedIdle, (calls) => [...calls, input]),
        }),
        Layer.mock(PreviewManager.PreviewManager)({
          listAll: Effect.succeed([
            tab("idle", "quiet-desktop"),
            tab("idle", "fresh-desktop", { updatedAt: RECENT_AT }),
            tab("idle", "server-hosted", { runtime: "server" }),
            tab("running", "running-desktop"),
            tab("recently-active", "recent-thread-desktop"),
            tab("deleted", "orphan-desktop"),
          ]),
          close: (input) =>
            Ref.update(closedTabs, (tabs) => [...tabs, `${input.threadId}:${input.tabId}`]),
        }),
      );

      yield* Effect.gen(function* () {
        const service = yield* IdleResourceReleaseService.make;
        yield* service.sweep();
      }).pipe(Effect.provide(layer));

      assert.deepStrictEqual(yield* Ref.get(closedIdle), [
        { threadId: "idle", idleSinceMs: CUTOFF_MS },
      ]);
      assert.deepStrictEqual(yield* Ref.get(closedTabs), ["idle:quiet-desktop"]);
      assert.notInclude(yield* Ref.get(threadReads), "command-only");
    }),
  );

  it("keeps a thread that waits on the user, has background work, or was just visited", () => {
    const nowMs = Date.parse(NOW);
    assert.isTrue(IdleResourceReleaseService.isThreadIdle(threadShell("idle"), nowMs, CUTOFF_MS));
    assert.isFalse(
      IdleResourceReleaseService.isThreadIdle(
        threadShell("waiting", {
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request-1"),
            kind: "user_input",
            createdAt: DateTime.makeUnsafe(QUIET_AT),
          },
        }),
        nowMs,
        CUTOFF_MS,
      ),
    );
    assert.isFalse(
      IdleResourceReleaseService.isThreadIdle(
        threadShell("dev-server", {
          pendingBackgroundTasks: [{ taskId: "task-1", kind: "command" }],
        }),
        nowMs,
        CUTOFF_MS,
      ),
    );
    assert.isFalse(
      IdleResourceReleaseService.isThreadIdle(
        threadShell("visited", { lastVisitedAt: DateTime.makeUnsafe(RECENT_AT) }),
        nowMs,
        CUTOFF_MS,
      ),
    );
  });
});
