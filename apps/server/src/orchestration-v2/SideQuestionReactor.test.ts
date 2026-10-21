import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as SideQuestionReactor from "./SideQuestionReactor.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" };

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in side question tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
  { name: "side-question-reactor" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer: layerDatabase, runEffectWorker: false },
);
const layerProjections = ProjectionStore.layer.pipe(Layer.provide(layerDatabase));
const layer = SideQuestionReactor.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(layerOrchestrator, layerProjections)),
);

const createThread = (id: string) =>
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(id);
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`command:create:${id}`),
      threadId,
      projectId: ProjectId.make("project:side-questions"),
      title: "Side questions",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });

const askQuestion = (threadId: ThreadId, id: string) =>
  Orchestrator.OrchestratorV2.use((engine) =>
    engine.dispatch({
      type: "thread.side-question.ask",
      commandId: CommandId.make(`command:ask:${id}`),
      threadId,
      sideThreadId: MessageId.make(id),
      messageId: MessageId.make(id),
      text: "What is the agent doing?",
      anchorMessageId: null,
    }),
  );

/** The recorded answer to `questionId`, waited for on the event log. */
const awaitAnswer = (questionId: string) =>
  EventSink.EventSinkV2.use((eventSink) =>
    eventSink.stream({ afterSequence: 0, eventType: "side-message.updated" }).pipe(
      Stream.map(({ event }) => (event.type === "side-message.updated" ? event.payload : null)),
      Stream.filter(
        (message) =>
          message !== null && message.sideThreadId === questionId && message.role !== "user",
      ),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    ),
  );

describe("SideQuestionReactor", () => {
  it.effect("answers without touching the thread, reporting a session that is not running", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reactor = yield* SideQuestionReactor.SideQuestionReactor;
        const engine = yield* Orchestrator.OrchestratorV2;
        yield* reactor.start();
        const threadId = yield* createThread("thread:side:live");
        const before = yield* engine.getThreadProjection(threadId);

        yield* askQuestion(threadId, "side:live");
        const answer = yield* awaitAnswer("side:live");
        yield* reactor.drain;

        assert.equal(answer?.role, "error");
        assert.equal(answer?.text, "Send a message in this thread before asking a side question.");
        const after = yield* engine.getThreadProjection(threadId);
        assert.deepEqual(
          after.sideMessages?.map((message) => message.role),
          ["user", "error"],
        );
        assert.deepEqual(after.thread.updatedAt, before.thread.updatedAt);
        assert.deepEqual(after.runs, []);

        // The failed answer frees the side thread for a follow-up.
        yield* engine.dispatch({
          type: "thread.side-question.ask",
          commandId: CommandId.make("command:ask:follow-up"),
          threadId,
          sideThreadId: MessageId.make("side:live"),
          messageId: MessageId.make("side:live:follow-up"),
          text: "And now?",
          anchorMessageId: null,
        });
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("settles questions a restart left unanswered", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = yield* createThread("thread:side:orphan");
        yield* askQuestion(threadId, "side:orphan");

        const reactor = yield* SideQuestionReactor.SideQuestionReactor;
        yield* reactor.start();
        const answer = yield* awaitAnswer("side:orphan");

        assert.equal(answer?.role, "error");
        assert.equal(answer?.text, SideQuestionReactor.SIDE_ANSWER_INTERRUPTED_TEXT);
      }),
    ).pipe(Effect.provide(layer)),
  );
});
