// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  MuseSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import {
  makeMuseAdapter,
  museApprovalModeForRuntimeMode,
  museApprovalOptions,
  museRequestType,
  museServeArgs,
  museToolItemType,
  museUserInputAnswers,
  parseMuseResume,
  selectMuseChoiceId,
} from "./MuseAdapter.ts";

const decodeMuseSettings = Schema.decodeSync(MuseSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockHostPath = NodePath.join(__dirname, "../../../scripts/msp-mock-host.ts");
const MUSE = ProviderDriverKind.make("muse");
const INSTANCE = ProviderInstanceId.make("muse");

async function makeMockMuse(env?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "muse-adapter-mock-"));
  const requestLogPath = NodePath.join(dir, "requests.ndjson");
  const command = writeFakeCli({
    directory: dir,
    name: "fake-muse",
    env: { T3_MSP_REQUEST_LOG_PATH: requestLogPath, ...env },
    source: execScriptSource({ scriptPath: mockHostPath, expectedArgs: ["serve"] }),
  });
  return { command, requestLogPath };
}

async function readRequests(requestLogPath: string) {
  const raw = await NodeFSP.readFile(requestLogPath, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> | null });
}

const THREE_CHOICES = [
  { choiceId: "allow_once", decision: "approved", label: "Allow once", scope: "once" },
  {
    choiceId: "allow_local_prefix",
    decision: "approvedPolicyAmendment",
    label: "Always allow in this workspace: rm ...",
    scope: "localPersistent",
  },
  { choiceId: "abort", decision: "abort", label: "Reject", scope: "once", acceptsFeedback: true },
];

it("maps runtime modes onto Muse approval modes and host flags", () => {
  assert.equal(museApprovalModeForRuntimeMode("approval-required"), "promptUnmatched");
  assert.equal(museApprovalModeForRuntimeMode("auto-accept-edits"), "promptUnmatched");
  assert.equal(museApprovalModeForRuntimeMode("auto"), "onRequest");
  assert.equal(museApprovalModeForRuntimeMode("full-access"), "allowAll");
  assert.deepEqual(museServeArgs("approval-required"), ["serve", "--trust-workspace"]);
  assert.deepEqual(museServeArgs("full-access"), [
    "serve",
    "--trust-workspace",
    "--disable-sandbox",
  ]);
});

it("reduces Muse approval choices to T3 decisions and picks the closest offered choice", () => {
  assert.deepEqual(museApprovalOptions(THREE_CHOICES), [
    { decision: "accept", label: "Allow once" },
    { decision: "acceptAlways", label: "Always allow in this workspace: rm ..." },
    { decision: "decline", label: "Reject" },
  ]);
  assert.equal(selectMuseChoiceId(THREE_CHOICES, "accept"), "allow_once");
  assert.equal(selectMuseChoiceId(THREE_CHOICES, "acceptAlways"), "allow_local_prefix");
  // Session scope is not offered; a narrower approval is the safe substitute.
  assert.equal(selectMuseChoiceId(THREE_CHOICES, "acceptForSession"), "allow_once");
  assert.equal(selectMuseChoiceId(THREE_CHOICES, "decline"), "abort");
  assert.equal(selectMuseChoiceId(THREE_CHOICES, "cancel"), "abort");
  assert.isUndefined(selectMuseChoiceId([THREE_CHOICES[2]!], "accept"));
});

it("classifies approval subjects and tool names", () => {
  assert.equal(
    museRequestType({ subject: { kind: "shell", command: "rm -rf x" } }),
    "exec_command_approval",
  );
  assert.equal(
    museRequestType({ toolName: "write_file", subject: { kind: "workspaceWrite", path: "a" } }),
    "file_change_approval",
  );
  assert.equal(
    museRequestType({ toolName: "read_file", subject: { kind: "read", path: "a" } }),
    "file_read_approval",
  );
  assert.equal(
    museRequestType({ toolName: "web_fetch", subject: { kind: "network" } }),
    "dynamic_tool_call",
  );
  assert.equal(museToolItemType("shell"), "command_execution");
  assert.equal(museToolItemType("write_file"), "file_change");
  assert.equal(museToolItemType("web_search"), "web_search");
  assert.equal(museToolItemType("github__list_issues"), "mcp_tool_call");
  assert.equal(museToolItemType("code_exec"), "command_execution");
});

it("turns T3 user-input answers into Muse answers by label or free text", () => {
  const questions = [
    {
      id: "q1",
      question: "Which area?",
      options: [{ label: "Frontend" }, { label: "Backend" }],
      selection: { mode: "single" as const },
    },
    {
      id: "q2",
      question: "Which files?",
      options: [{ label: "a.ts" }, { label: "b.ts" }],
      selection: { mode: "multiple" as const },
    },
  ];
  assert.deepEqual(museUserInputAnswers(questions, { q1: "Backend", q2: ["a.ts", "c.ts"] }), [
    { questionId: "q1", selectedLabel: "Backend" },
    { questionId: "q2", selectedLabels: ["a.ts"], freeText: "c.ts" },
  ]);
  assert.deepEqual(museUserInputAnswers(questions, { "Which area?": "something else" }), [
    { questionId: "q1", freeText: "something else" },
  ]);
});

it("parses only its own resume cursor", () => {
  assert.deepEqual(parseMuseResume({ schemaVersion: 1, sessionId: "abc" }), { sessionId: "abc" });
  assert.isUndefined(parseMuseResume({ schemaVersion: 2, sessionId: "abc" }));
  assert.isUndefined(parseMuseResume({ sessionId: "abc" }));
  assert.isUndefined(parseMuseResume(undefined));
});

const museAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-muse-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string) =>
  makeMuseAdapter(decodeMuseSettings({ binaryPath }), { instanceId: INSTANCE }).pipe(Effect.orDie);

const collectEvents = (adapter: { readonly streamEvents: Stream.Stream<ProviderRuntimeEvent> }) =>
  Effect.gen(function* () {
    const events: ProviderRuntimeEvent[] = [];
    const turnCompleted = yield* Deferred.make<void>();
    const requestOpened = yield* Deferred.make<ProviderRuntimeEvent>();
    const userInputRequested = yield* Deferred.make<ProviderRuntimeEvent>();
    const sessionExited = yield* Deferred.make<void>();
    const fiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "turn.completed") yield* Deferred.succeed(turnCompleted, undefined);
        if (event.type === "request.opened") yield* Deferred.succeed(requestOpened, event);
        if (event.type === "user-input.requested")
          yield* Deferred.succeed(userInputRequested, event);
        if (event.type === "session.exited") yield* Deferred.succeed(sessionExited, undefined);
      }),
    ).pipe(Effect.forkChild);
    return { events, turnCompleted, requestOpened, userInputRequested, sessionExited, fiber };
  });

it.layer(museAdapterTestLayer)("MuseAdapterLive", (it) => {
  it.effect("maps a mock turn to runtime events with streamed text and token usage", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("muse-mock-turn");
      const { command, requestLogPath } = yield* Effect.promise(() => makeMockMuse());
      const adapter = yield* makeTestAdapter(command);
      const collected = yield* collectEvents(adapter);

      const session = yield* adapter.startSession({
        threadId,
        provider: MUSE,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: INSTANCE, model: "muse-spark-1.3" },
      });
      assert.equal(session.provider, "muse");
      assert.equal(session.model, "muse-spark-1.3");
      assert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: (session.resumeCursor as { sessionId: string }).sessionId,
      });

      const turn = yield* adapter.sendTurn({ threadId, input: "hello muse" });
      yield* Deferred.await(collected.turnCompleted);
      yield* Fiber.interrupt(collected.fiber);

      const types = collected.events.map((event) => event.type);
      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "item.started",
        "content.delta",
        "item.completed",
        "thread.token-usage.updated",
        "turn.completed",
      ]);
      const deltas = collected.events.flatMap((event) =>
        event.type === "content.delta" ? [event.payload.delta] : [],
      );
      assert.equal(deltas.join(""), "Hello from Muse");
      const completed = collected.events.find((event) => event.type === "turn.completed");
      assert.isDefined(completed);
      if (completed?.type === "turn.completed") {
        assert.equal(String(completed.turnId), String(turn.turnId));
        assert.equal(completed.payload.state, "completed");
        assert.equal(completed.payload.tokenUsage?.usageStatus, "complete");
        assert.equal(completed.payload.tokenUsage?.inputTokens, 120);
      }
      const usage = collected.events.find((event) => event.type === "thread.token-usage.updated");
      if (usage?.type === "thread.token-usage.updated") {
        assert.equal(usage.payload.usage.usedTokens, 120);
      }
      const turnStarted = collected.events.filter((event) => event.type === "turn.started");
      assert.equal(turnStarted.length, 1);

      const requests = yield* Effect.promise(() => readRequests(requestLogPath));
      const start = requests.find((request) => request.method === "session/start");
      assert.equal(start?.params?.approvalMode, "promptUnmatched");
      assert.equal(start?.params?.modelId, "muse-spark-1.3");
      const turnStart = requests.find((request) => request.method === "turn/start");
      assert.deepEqual(turnStart?.params?.input, [{ type: "text", text: "hello muse" }]);
      assert.match(String(turnStart?.params?.commandId), /^[0-9a-f-]{36}$/);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "opens an approval, answers it with the host's current requirement, and finishes the turn",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("muse-mock-approval");
        const { command, requestLogPath } = yield* Effect.promise(() =>
          makeMockMuse({ T3_MSP_EMIT_APPROVAL: "1" }),
        );
        const adapter = yield* makeTestAdapter(command);
        const collected = yield* collectEvents(adapter);
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        yield* adapter.sendTurn({ threadId, input: "delete the build folder" });

        const opened = yield* Deferred.await(collected.requestOpened);
        assert.equal(opened.type, "request.opened");
        if (opened.type !== "request.opened") return;
        assert.equal(opened.payload.requestType, "exec_command_approval");
        assert.equal(opened.payload.detail, "rm -rf build");
        assert.deepEqual(
          opened.payload.options?.map((option) => option.decision),
          ["accept", "acceptAlways", "decline"],
        );
        assert.isDefined(opened.requestId);

        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make(String(opened.requestId)),
          "accept",
        );
        yield* Deferred.await(collected.turnCompleted);
        yield* Fiber.interrupt(collected.fiber);

        const resolved = collected.events.filter((event) => event.type === "request.resolved");
        assert.equal(resolved.length, 1);
        if (resolved[0]?.type === "request.resolved") {
          assert.equal(resolved[0].payload.decision, "accept");
        }
        const tool = collected.events.find(
          (event) =>
            event.type === "item.completed" && event.payload.itemType === "command_execution",
        );
        assert.isDefined(tool);
        if (tool?.type === "item.completed") {
          assert.equal(tool.payload.detail, "echo hi");
          assert.equal((tool.payload.data as { rawOutput?: string }).rawOutput, "hi\n");
        }
        const requests = yield* Effect.promise(() => readRequests(requestLogPath));
        const decide = requests.find((request) => request.method === "approval/decide");
        assert.equal(decide?.params?.choiceId, "allow_once");
        assert.deepEqual(decide?.params?.requirementId, {
          approvalId: decide?.params?.approvalId,
          sourceIndex: 1,
        });
        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("relays user-input questions and answers", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("muse-mock-user-input");
      const { command, requestLogPath } = yield* Effect.promise(() =>
        makeMockMuse({ T3_MSP_EMIT_USER_INPUT: "1" }),
      );
      const adapter = yield* makeTestAdapter(command);
      const collected = yield* collectEvents(adapter);
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "change something" });

      const requested = yield* Deferred.await(collected.userInputRequested);
      if (requested.type !== "user-input.requested") return;
      assert.equal(requested.payload.questions[0]?.id, "q1");
      assert.equal(requested.payload.questions[0]?.header, "Scope");
      assert.deepEqual(
        requested.payload.questions[0]?.options.map((option) => option.label),
        ["Frontend", "Backend"],
      );
      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(requested.requestId)),
        {
          q1: "Backend",
        },
      );
      yield* Deferred.await(collected.turnCompleted);
      yield* Fiber.interrupt(collected.fiber);

      const resolved = collected.events.filter((event) => event.type === "user-input.resolved");
      assert.equal(resolved.length, 1);
      const requests = yield* Effect.promise(() => readRequests(requestLogPath));
      const answer = requests.find((request) => request.method === "userInput/answer");
      assert.deepEqual(answer?.params?.answers, [{ questionId: "q1", selectedLabel: "Backend" }]);
      const start = requests.find((request) => request.method === "session/start");
      assert.equal(start?.params?.approvalMode, "allowAll");
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("resumes a session by id and interrupts a turn the dead host left running", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("muse-mock-resume");
      const { command, requestLogPath } = yield* Effect.promise(() =>
        makeMockMuse({ T3_MSP_RESUME_ACTIVE_TURN_ID: "stale-turn" }),
      );
      const adapter = yield* makeTestAdapter(command);
      const session = yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "auto",
        resumeCursor: { schemaVersion: 1, sessionId: "resume-123" },
      });
      assert.deepEqual(session.resumeCursor, { schemaVersion: 1, sessionId: "resume-123" });
      const requests = yield* Effect.promise(() => readRequests(requestLogPath));
      const methods = requests.map((request) => request.method);
      assert.notInclude(methods, "session/start");
      const resume = requests.find((request) => request.method === "session/resume");
      assert.equal(resume?.params?.sessionId, "resume-123");
      const interrupt = requests.find((request) => request.method === "turn/interrupt");
      assert.equal(interrupt?.params?.turnId, "stale-turn");
      const mode = requests.find((request) => request.method === "session/setApprovalMode");
      assert.equal(mode?.params?.mode, "onRequest");
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("interrupts a running turn and settles it as cancelled", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("muse-mock-interrupt");
      const { command } = yield* Effect.promise(() => makeMockMuse({ T3_MSP_HANG_TURN: "1" }));
      const adapter = yield* makeTestAdapter(command);
      const collected = yield* collectEvents(adapter);
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      const first = yield* adapter.sendTurn({ threadId, input: "take forever" });
      // A second prompt while busy steers the live turn instead of opening another.
      const second = yield* adapter.sendTurn({ threadId, input: "also this" });
      assert.equal(String(second.turnId), String(first.turnId));
      yield* adapter.interruptTurn(threadId, first.turnId);
      yield* Deferred.await(collected.turnCompleted);
      yield* Fiber.interrupt(collected.fiber);
      const completed = collected.events.find((event) => event.type === "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "cancelled");
        assert.equal(String(completed.turnId), String(first.turnId));
      }
      assert.equal(collected.events.filter((event) => event.type === "turn.started").length, 1);
      const sessions = yield* adapter.listSessions();
      assert.equal(sessions[0]?.status, "ready");
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("fails the active turn and exits the session when the host dies", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("muse-mock-host-death");
      const { command } = yield* Effect.promise(() =>
        makeMockMuse({ T3_MSP_EXIT_AFTER_TURN_START: "1" }),
      );
      const adapter = yield* makeTestAdapter(command);
      const collected = yield* collectEvents(adapter);
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "crash please" });
      yield* Deferred.await(collected.turnCompleted);
      yield* Deferred.await(collected.sessionExited);
      yield* Fiber.interrupt(collected.fiber);
      const completed = collected.events.find((event) => event.type === "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "failed");
        assert.include(completed.payload.errorMessage ?? "", "exit code 3");
      }
      const exited = collected.events.find((event) => event.type === "session.exited");
      if (exited?.type === "session.exited") {
        assert.equal(exited.payload.exitKind, "error");
        assert.equal(exited.payload.recoverable, true);
      }
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );

  it.effect("switches the model in-session before the next turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("muse-mock-model-switch");
      const { command, requestLogPath } = yield* Effect.promise(() => makeMockMuse());
      const adapter = yield* makeTestAdapter(command);
      const collected = yield* collectEvents(adapter);
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter.sendTurn({
        threadId,
        input: "hi",
        modelSelection: {
          instanceId: INSTANCE,
          model: "muse-spark-1.2",
          options: [{ id: "reasoningEffort", value: "low" }],
        },
      });
      yield* Deferred.await(collected.turnCompleted);
      const requests = yield* Effect.promise(() => readRequests(requestLogPath));
      const setModel = requests.find((request) => request.method === "session/setModel");
      assert.deepEqual(setModel?.params?.model, { modelId: "muse-spark-1.2" });
      const turnStart = requests.find((request) => request.method === "turn/start");
      assert.equal(turnStart?.params?.reasoningEffort, "low");
      const sessions = yield* adapter.listSessions();
      assert.equal(sessions[0]?.model, "muse-spark-1.2");
      const started = collected.events.find((event) => event.type === "turn.started");
      if (started?.type === "turn.started") {
        assert.equal(started.payload.model, "muse-spark-1.2");
        assert.equal(started.payload.effort, "low");
      }
      yield* adapter.stopSession(threadId);
      yield* Deferred.await(collected.sessionExited);
      yield* Fiber.interrupt(collected.fiber);
      const exited = collected.events.find((event) => event.type === "session.exited");
      if (exited?.type === "session.exited") {
        assert.equal(exited.payload.exitKind, "graceful");
      }
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );
});
