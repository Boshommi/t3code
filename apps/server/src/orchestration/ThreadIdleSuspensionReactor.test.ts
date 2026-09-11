import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  type PreviewListResult,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "@effect/vitest";

import * as PreviewManager from "../preview/Manager.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadIdleSuspensionReactor from "./ThreadIdleSuspensionReactor.ts";

const NOW = "2026-09-11T20:00:00.000Z";
const IDLE_AT = "2026-09-11T19:54:00.000Z";
const ACTIVE_AT = "2026-09-11T19:59:00.000Z";

const makeThread = (
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id: ThreadId.make(id),
  projectId: ProjectId.make("project-1"),
  title: id,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: IDLE_AT,
  updatedAt: IDLE_AT,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: IDLE_AT,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

const makeTerminal = (
  threadId: string,
  terminalId: string,
  overrides: Partial<TerminalSummary> = {},
): TerminalSummary => ({
  threadId,
  terminalId,
  cwd: "/repo",
  worktreePath: null,
  status: "running",
  pid: 123,
  exitCode: null,
  exitSignal: null,
  hasRunningSubprocess: false,
  label: terminalId,
  updatedAt: IDLE_AT,
  ...overrides,
});

const makePreviews = (threadId: string): PreviewListResult => ({
  sessions: [
    {
      threadId,
      tabId: "tab-1",
      navStatus: { _tag: "Success", url: "http://localhost:3000/", title: "App" },
      canGoBack: false,
      canGoForward: false,
      updatedAt: IDLE_AT,
    },
  ],
  serverEpoch: "epoch",
  revision: 1,
});

describe("ThreadIdleSuspensionReactor", () => {
  it.effect("suspends idle shells and previews of idle threads only", () =>
    Effect.gen(function* () {
      const closedTerminals = yield* Ref.make<ReadonlyArray<string>>([]);
      const closedPreviews = yield* Ref.make<ReadonlyArray<string>>([]);

      const snapshot: OrchestrationShellSnapshot = {
        snapshotSequence: 1,
        projects: [],
        threads: [
          makeThread("idle-thread"),
          makeThread("coding-thread", {
            updatedAt: ACTIVE_AT,
            latestUserMessageAt: ACTIVE_AT,
            session: {
              threadId: ThreadId.make("coding-thread"),
              providerName: "codex",
              runtimeMode: "full-access",
              status: "running",
              activeTurnId: TurnId.make("turn-1"),
              lastError: null,
              updatedAt: ACTIVE_AT,
            },
          }),
        ],
        updatedAt: ACTIVE_AT,
      };
      const terminals: ReadonlyArray<TerminalSummary> = [
        makeTerminal("idle-thread", "term-1"),
        makeTerminal("idle-thread", "term-2", { hasRunningSubprocess: true }),
        makeTerminal("coding-thread", "term-1"),
      ];

      const layer = ThreadIdleSuspensionReactor.layer.pipe(
        Layer.provide(
          Layer.succeed(ProjectionSnapshotQuery, {
            getShellSnapshot: () => Effect.succeed(snapshot),
          } as unknown as ProjectionSnapshotQuery["Service"]),
        ),
        Layer.provide(
          Layer.succeed(TerminalManager.TerminalManager, {
            list: () => Effect.succeed(terminals),
            close: (input: { threadId: string; terminalId?: string }) =>
              Ref.update(closedTerminals, (closed) => [
                ...closed,
                `${input.threadId}:${input.terminalId}`,
              ]).pipe(Effect.asVoid),
          } as unknown as TerminalManager.TerminalManager["Service"]),
        ),
        Layer.provide(
          Layer.succeed(PreviewManager.PreviewManager, {
            list: (input: { threadId: ThreadId }) =>
              Effect.succeed(
                input.threadId === "idle-thread" || input.threadId === "coding-thread"
                  ? makePreviews(input.threadId)
                  : { sessions: [], serverEpoch: "epoch", revision: 1 },
              ),
            close: (input: { threadId: ThreadId }) =>
              Ref.update(closedPreviews, (closed) => [...closed, input.threadId]).pipe(
                Effect.asVoid,
              ),
          } as unknown as PreviewManager.PreviewManager["Service"]),
        ),
      );

      yield* Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const reactor = yield* ThreadIdleSuspensionReactor.ThreadIdleSuspensionReactor;
        yield* reactor.suspendOnce;
        expect(yield* Ref.get(closedTerminals)).toEqual(["idle-thread:term-1"]);
        expect(yield* Ref.get(closedPreviews)).toEqual(["idle-thread"]);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );
});
