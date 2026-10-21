import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ProcessRunner, type ProcessRunInput, type ProcessRunOutput } from "../processRunner.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ShellCommandReactor from "./ShellCommandReactor.ts";
import { isShellCommandTurnItem, type ShellCommandTurnItem } from "./ShellCommands.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" };

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in shell command tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const output = (overrides: Partial<ProcessRunOutput>): ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: 0 as ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
  ...overrides,
});

/** A runner that records each spawn and finishes once the test releases it. */
const makeRunner = Effect.gen(function* () {
  const spawned: Array<ProcessRunInput> = [];
  const release = yield* Deferred.make<ProcessRunOutput>();
  const runner: ProcessRunner["Service"] = {
    run: (input) =>
      Effect.sync(() => spawned.push(input)).pipe(Effect.andThen(Deferred.await(release))),
  };
  return { spawned, release, runner };
});

const layerFor = (runner: ProcessRunner["Service"]) => {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "shell-command-reactor" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerStores = Layer.mergeAll(ProjectionStore.layer, ProjectStore.layer).pipe(
    Layer.provide(layerDatabase),
  );
  return ShellCommandReactor.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerOrchestrator,
        layerStores,
        Layer.succeed(ProcessRunner, runner),
        NodeServices.layer,
      ),
    ),
  );
};

const createThread = (id: string) =>
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(id);
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`command:create:${id}`),
      threadId,
      projectId: ProjectId.make("project:shell-commands"),
      title: "Shell commands",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/repo",
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });

const send = (threadId: ThreadId, text: string, type: "start_immediately" | "queue_after_active") =>
  Orchestrator.OrchestratorV2.use((engine) =>
    engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`command:send:${text}`),
      threadId,
      messageId: MessageId.make(`message:${text}`),
      text,
      attachments: [],
      dispatchMode: { type },
      createdBy: "user",
      creationSource: "web",
    }),
  );

const runShellCommand = (threadId: ThreadId, command: string) =>
  Orchestrator.OrchestratorV2.use((engine) =>
    engine.dispatch({
      type: "thread.shell-command.run",
      commandId: CommandId.make(`command:shell:${command}`),
      threadId,
      command,
    }),
  );

const commandItems = (threadId: ThreadId) =>
  Orchestrator.OrchestratorV2.use((engine) => engine.getThreadProjection(threadId)).pipe(
    Effect.map((projection) => projection.turnItems.filter(isShellCommandTurnItem)),
  );

/** The finished shell command item, waited for on the event log. */
const awaitFinished = EventSink.EventSinkV2.use((eventSink) =>
  eventSink.stream({ afterSequence: 0, eventType: "turn-item.updated" }).pipe(
    Stream.map(({ event }) =>
      event.type === "turn-item.updated" &&
      isShellCommandTurnItem(event.payload) &&
      event.payload.status !== "running"
        ? event.payload
        : null,
    ),
    Stream.filter((item): item is ShellCommandTurnItem => item !== null),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  ),
);

const withReactor = <A, E, R>(runner: ProcessRunner["Service"], test: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const reactor = yield* ShellCommandReactor.ShellCommandReactor;
      yield* reactor.start();
      const result = yield* test;
      yield* reactor.drain;
      return result;
    }),
  ).pipe(
    Effect.provide(layerFor(runner)),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.Environment, { SHELL: "/bin/zsh" }),
  );

/** Runs `echo hi` in a fresh thread and returns the item before and after the process ends. */
const runToCompletion = (result: ProcessRunOutput) =>
  Effect.gen(function* () {
    const { spawned, release, runner } = yield* makeRunner;
    return yield* withReactor(
      runner,
      Effect.gen(function* () {
        const threadId = yield* createThread("thread:shell");
        yield* runShellCommand(threadId, "echo hi");
        const running = yield* commandItems(threadId);
        yield* Deferred.succeed(release, result);
        const finished = yield* awaitFinished;
        return { running, finished, spawned };
      }),
    );
  });

describe("ShellCommandReactor", () => {
  it.effect("shows the command running, then completes the same run-less item", () =>
    Effect.gen(function* () {
      const { running, finished, spawned } = yield* runToCompletion(output({ stdout: "hi\n" }));

      assert.deepStrictEqual(
        running.map((item) => [item.status, item.runId, item.input]),
        [["running", null, "echo hi"]],
      );
      assert.strictEqual(finished.id, running[0]!.id);
      assert.strictEqual(finished.ordinal, running[0]!.ordinal);
      assert.strictEqual(finished.status, "completed");
      assert.strictEqual(finished.output, "hi");
      assert.strictEqual(finished.exitCode, 0);
      assert.isNotNull(finished.completedAt);
      assert.deepStrictEqual(
        { command: spawned[0]?.command, args: spawned[0]?.args, cwd: spawned[0]?.cwd },
        { command: "/bin/zsh", args: ["-lc", "echo hi"], cwd: "/repo" },
      );
    }),
  );

  it.effect("fails on a nonzero exit and keeps stderr", () =>
    Effect.gen(function* () {
      const { finished } = yield* runToCompletion(
        output({ stdout: "out", stderr: "boom", code: 2 as ProcessRunOutput["code"] }),
      );

      assert.strictEqual(finished.status, "failed");
      assert.strictEqual(finished.exitCode, 2);
      assert.strictEqual(finished.output, "out\nboom");
    }),
  );

  it.effect("reports a timeout as a failure", () =>
    Effect.gen(function* () {
      const { finished } = yield* runToCompletion(output({ timedOut: true, code: null }));

      assert.strictEqual(finished.status, "failed");
      assert.strictEqual(finished.outputIndicatesFailure, true);
      assert.include(finished.output, "timed out");
    }),
  );

  it.effect("lands after everything in the thread and leaves its runs alone", () =>
    Effect.gen(function* () {
      const { release, runner } = yield* makeRunner;
      yield* Deferred.succeed(release, output({ stdout: "clean" }));
      yield* withReactor(
        runner,
        Effect.gen(function* () {
          const engine = yield* Orchestrator.OrchestratorV2;
          const threadId = yield* createThread("thread:shell:busy");
          yield* send(threadId, "first", "start_immediately");
          yield* send(threadId, "second", "queue_after_active");
          const before = yield* engine.getThreadProjection(threadId);
          assert.include(
            before.runs.map((run) => run.status),
            "queued",
          );

          yield* runShellCommand(threadId, "ls");
          const finished = yield* awaitFinished;

          const after = yield* engine.getThreadProjection(threadId);
          assert.deepStrictEqual(after.runs, before.runs);
          const others = after.turnItems.filter((item) => item.id !== finished.id);
          assert.isAbove(others.length, 0);
          assert.isTrue(others.every((item) => item.ordinal < finished.ordinal));
          assert.strictEqual(after.visibleTurnItems.at(-1)?.sourceItemId, finished.id);
        }),
      );
    }),
  );

  it.effect("rejects a thread that does not exist", () =>
    Effect.gen(function* () {
      const { runner } = yield* makeRunner;
      const error = yield* withReactor(
        runner,
        runShellCommand(ThreadId.make("thread:missing"), "ls").pipe(Effect.flip),
      );

      assert.include(error._tag, "Orchestrator");
    }),
  );
});
