#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * Mock `muse serve` host for adapter tests. Speaks the subset of MSP the
 * MuseAdapter uses, over NDJSON on stdio, and is driven by environment flags.
 */
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";

const requestLogPath = process.env.T3_MSP_REQUEST_LOG_PATH;
const emitApproval = process.env.T3_MSP_EMIT_APPROVAL === "1";
const emitUserInput = process.env.T3_MSP_EMIT_USER_INPUT === "1";
const emitExtraToolCall = process.env.T3_MSP_EMIT_TOOL_CALL === "1";
const exitAfterTurnStart = process.env.T3_MSP_EXIT_AFTER_TURN_START === "1";
const hangTurnForever = process.env.T3_MSP_HANG_TURN === "1";
const resumeActiveTurnId = process.env.T3_MSP_RESUME_ACTIVE_TURN_ID;
const responseText = process.env.T3_MSP_RESPONSE_TEXT ?? "Hello from Muse";

let sequence = 0;
const uuid7 = (): string => {
  const hex = NodeCrypto.randomUUID().replace(/-/g, "");
  const time = Date.now().toString(16).padStart(12, "0");
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

function send(frame: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
}
function notify(method: string, params: Record<string, unknown>): void {
  send({ method, params });
}
function respond(id: unknown, result: unknown): void {
  send({ id, result });
}
function respondError(id: unknown, code: number, message: string, kind: string): void {
  send({ id, error: { code, message, data: { kind } } });
}
function log(record: Record<string, unknown>): void {
  if (requestLogPath) {
    NodeFS.appendFileSync(requestLogPath, `${JSON.stringify(record)}\n`);
  }
}
const cursor = (sessionId: string) => `v:${sessionId}:${++sequence}`;

interface SessionState {
  readonly sessionId: string;
  modelId: string;
  activeTurnId: string | null;
  approvalMode: string;
  pendingApproval: { approvalId: string; turnId: string; stage: number } | null;
  pendingUserInput: { userInputId: string; turnId: string } | null;
}

let initialized = false;
const sessions = new Map<string, SessionState>();
const MODELS = [
  {
    modelId: "muse-spark-1.3",
    displayLabel: "muse-spark-1.3",
    isDefault: false,
    contextLimit: 1_000_000,
  },
  {
    modelId: "muse-spark-1.3-contributor",
    displayLabel: "muse-spark-1.3-contributor",
    isDefault: true,
    contextLimit: 1_000_000,
  },
];

function makeSession(
  sessionId: string,
  modelId: string | undefined,
  approvalMode: string | undefined,
) {
  const session: SessionState = {
    sessionId,
    modelId: modelId ?? "muse-spark-1.3-contributor",
    activeTurnId: null,
    approvalMode: approvalMode ?? "promptUnmatched",
    pendingApproval: null,
    pendingUserInput: null,
  };
  sessions.set(sessionId, session);
  return session;
}

function sessionView(session: SessionState) {
  return {
    sessionId: session.sessionId,
    status: session.activeTurnId ? "running" : "idle",
    modelId: session.modelId,
    activeTurnId: session.activeTurnId,
    workspaceRoot: process.cwd(),
    turnCount: 0,
    path: `/mock/sessions/${session.sessionId}/session.jsonl`,
    approvalMode: { mode: session.approvalMode, source: "startup", lastCommandId: null },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    forkedFrom: null,
    providerId: "meta",
  };
}

function finishTurn(session: SessionState, turnId: string, terminal: "completed" | "cancelled") {
  if (session.activeTurnId !== turnId) return;
  session.activeTurnId = null;
  notify("turn/completed", {
    sessionId: session.sessionId,
    turnId,
    terminal,
    ...(terminal === "cancelled" ? { reason: "interrupted" } : {}),
    durationMs: 5,
    usage: { inputTokens: 120, outputTokens: 12, cachedTokens: 40, reasoningTokens: 3 },
    viewCursor: cursor(session.sessionId),
    sourceRange: {},
  });
}

function emitAssistantMessage(session: SessionState, turnId: string) {
  const itemId = NodeCrypto.randomUUID();
  notify("item/started", {
    sessionId: session.sessionId,
    item: { itemId, kind: "agentMessage", status: "inProgress", revision: 1, turnId, text: "" },
    viewCursor: cursor(session.sessionId),
  });
  const half = Math.ceil(responseText.length / 2);
  notify("item/delta", {
    sessionId: session.sessionId,
    itemId,
    delta: responseText.slice(0, half),
    field: "text",
    viewCursor: cursor(session.sessionId),
  });
  notify("item/delta", {
    sessionId: session.sessionId,
    itemId,
    delta: responseText.slice(half),
    field: "text",
    viewCursor: cursor(session.sessionId),
  });
  notify("item/completed", {
    sessionId: session.sessionId,
    item: {
      itemId,
      kind: "agentMessage",
      status: "completed",
      revision: 2,
      turnId,
      text: responseText,
    },
    viewCursor: cursor(session.sessionId),
    sourceRange: {},
  });
  notify("session/tokenUsage", {
    sessionId: session.sessionId,
    turnId,
    promptTokens: 120,
    totalTokens: 132,
    modelId: session.modelId,
    usage: { inputTokens: 120, outputTokens: 12, cachedTokens: 40, reasoningTokens: 3 },
    cumulative: { promptTokens: 120, outputTokens: 12, totalTokens: 132 },
    viewCursor: cursor(session.sessionId),
    sourceRange: {},
  });
  notify("session/contextUsage", {
    sessionId: session.sessionId,
    usedTokens: 120,
    windowTokens: 1_000_000,
    pressure: "normal",
    viewCursor: cursor(session.sessionId),
    sourceRange: {},
  });
}

function emitToolCall(session: SessionState, turnId: string, approvalId?: string) {
  const itemId = approvalId ?? NodeCrypto.randomUUID();
  notify("item/started", {
    sessionId: session.sessionId,
    item: {
      itemId,
      kind: "toolCall",
      status: "inProgress",
      revision: 1,
      turnId,
      tool: "shell",
      args: JSON.stringify({ command: "echo hi" }),
    },
    viewCursor: cursor(session.sessionId),
  });
  notify("item/completed", {
    sessionId: session.sessionId,
    item: {
      itemId,
      kind: "toolCall",
      status: "completed",
      revision: 2,
      turnId,
      tool: "shell",
      args: JSON.stringify({ command: "echo hi" }),
      visibleOutput: "hi\n",
      exitCode: 0,
    },
    viewCursor: cursor(session.sessionId),
    sourceRange: {},
  });
}

function continueAfterGates(session: SessionState, turnId: string) {
  if (emitUserInput && !session.pendingUserInput && !userInputDone.has(turnId)) {
    const userInputId = NodeCrypto.randomUUID();
    session.pendingUserInput = { userInputId, turnId };
    notify("userInput/requested", {
      sessionId: session.sessionId,
      turnId,
      userInputId,
      itemId: userInputId,
      toolCallId: NodeCrypto.randomUUID(),
      toolName: "request_user_input",
      questions: [
        {
          id: "q1",
          header: "Scope",
          question: "Which area should I change?",
          options: [
            { label: "Frontend", description: "React code" },
            { label: "Backend", description: "Server code" },
          ],
          selection: { mode: "single" },
        },
      ],
      viewCursor: cursor(session.sessionId),
    });
    return;
  }
  if (emitExtraToolCall) {
    emitToolCall(session, turnId);
  }
  emitAssistantMessage(session, turnId);
  finishTurn(session, turnId, "completed");
}

const userInputDone = new Set<string>();

function startTurn(session: SessionState, turnId: string) {
  session.activeTurnId = turnId;
  notify("turn/started", {
    sessionId: session.sessionId,
    turnId,
    commandId: turnId,
    viewCursor: cursor(session.sessionId),
    sourceRange: {},
  });
  if (exitAfterTurnStart) {
    process.exit(3);
  }
  if (hangTurnForever) {
    return;
  }
  if (emitApproval) {
    const approvalId = NodeCrypto.randomUUID();
    session.pendingApproval = { approvalId, turnId, stage: 0 };
    notify("approval/requested", {
      sessionId: session.sessionId,
      turnId,
      approvalId,
      itemId: approvalId,
      toolCallId: approvalId,
      toolName: "shell",
      rawArgs: JSON.stringify({ command: "rm -rf build" }),
      subject: { kind: "shell", command: "rm -rf build" },
      availableChoices: [
        { choiceId: "allow_once", decision: "approved", label: "Allow once", scope: "once" },
        {
          choiceId: "allow_local_prefix",
          decision: "approvedPolicyAmendment",
          label: "Always allow in this workspace: rm ...",
          scope: "localPersistent",
        },
        {
          choiceId: "abort",
          decision: "abort",
          label: "Reject",
          scope: "once",
          acceptsFeedback: true,
        },
      ],
      currentRequirementId: { approvalId, sourceIndex: 1 },
      judgeEscalated: false,
      protectedWrite: false,
      viewCursor: cursor(session.sessionId),
      sourceRange: {},
    });
    return;
  }
  continueAfterGates(session, turnId);
}

function handle(frame: Record<string, unknown>) {
  const { id, method, params } = frame as {
    id?: unknown;
    method?: string;
    params?: Record<string, unknown>;
  };
  if (typeof method !== "string") return;
  log({ method, params: params ?? null });
  if (id === undefined) {
    if (method === "initialized") initialized = true;
    return;
  }
  if (method === "initialize") {
    respond(id, {
      experimentalApi: false,
      grantedCapabilities: [],
      museHome: "/mock/muse",
      platformFamily: "unix",
      platformOs: "linux",
      schema: { version: 1, fingerprint: "sha256:mock" },
      serverInfo: { name: "muse", version: "1.0.3" },
      sessionDurability: "durable",
      userAgent: "muse-mock",
    });
    return;
  }
  if (!initialized) {
    respondError(id, -32600, "Not initialized", "notInitialized");
    return;
  }
  const p = params ?? {};
  switch (method) {
    case "model/list":
      respond(id, {
        models: MODELS,
        providerId: "meta",
        profileId: "tbh",
        source: "providerCatalog",
      });
      return;
    case "session/start": {
      const session = makeSession(
        typeof p.sessionId === "string" ? p.sessionId : uuid7(),
        typeof p.modelId === "string" ? p.modelId : undefined,
        typeof p.approvalMode === "string" ? p.approvalMode : undefined,
      );
      notify("session/started", { session: sessionView(session) });
      respond(id, { session: sessionView(session), viewCursor: "" });
      return;
    }
    case "session/resume": {
      const sessionId = String(p.sessionId);
      if (!sessionId.startsWith("resume-") && !sessions.has(sessionId)) {
        respondError(id, -32000, `Unknown session ${sessionId}`, "sessionNotFound");
        return;
      }
      const session =
        sessions.get(sessionId) ?? makeSession(sessionId, undefined, "promptUnmatched");
      if (resumeActiveTurnId) session.activeTurnId = resumeActiveTurnId;
      respond(id, {
        session: sessionView(session),
        viewCursor: cursor(sessionId),
        pendingRequests: [],
        history: { mode: "none", items: null, snapshot: null },
      });
      return;
    }
    case "session/setApprovalMode": {
      const session = sessions.get(String(p.sessionId));
      if (session) session.approvalMode = String(p.mode);
      respond(id, { commandId: p.commandId, status: "accepted" });
      return;
    }
    case "session/setModel": {
      const session = sessions.get(String(p.sessionId));
      const model = (p.model as { modelId?: string } | undefined)?.modelId;
      if (session && model) {
        session.modelId = model;
        notify("session/modelChanged", {
          sessionId: session.sessionId,
          modelId: model,
          viewCursor: cursor(session.sessionId),
          sourceRange: {},
        });
      }
      respond(id, { commandId: p.commandId, status: "accepted" });
      return;
    }
    case "turn/start": {
      const session = sessions.get(String(p.sessionId));
      if (!session) {
        respondError(id, -32000, "Unknown session", "sessionNotFound");
        return;
      }
      if (session.activeTurnId) {
        respond(id, {
          commandId: p.commandId,
          turnId: session.activeTurnId,
          disposition: "steered",
          startedNewTurn: false,
          status: "accepted",
        });
        return;
      }
      const turnId = String(p.commandId);
      respond(id, {
        commandId: p.commandId,
        turnId,
        disposition: "started",
        startedNewTurn: true,
        status: "accepted",
      });
      startTurn(session, turnId);
      return;
    }
    case "turn/interrupt": {
      const session = sessions.get(String(p.sessionId));
      if (!session || !session.activeTurnId) {
        respondError(id, -32000, "No active turn", "notFound");
        return;
      }
      const turnId = session.activeTurnId;
      respond(id, { commandId: p.commandId, status: "accepted" });
      if (session.pendingApproval) {
        notify("approval/resolved", {
          sessionId: session.sessionId,
          approvalId: session.pendingApproval.approvalId,
          itemId: session.pendingApproval.approvalId,
          turnId,
          decision: "abort",
          resolvedBy: "interrupt",
          policyResult: "deny",
          viewCursor: cursor(session.sessionId),
          sourceRange: {},
          stageEvidence: [],
        });
        session.pendingApproval = null;
      }
      finishTurn(session, turnId, "cancelled");
      return;
    }
    case "approval/decide": {
      const session = sessions.get(String(p.sessionId));
      const pending = session?.pendingApproval;
      if (!session || !pending || pending.approvalId !== p.approvalId) {
        respondError(id, -32000, "Unknown approval", "approvalNotFound");
        return;
      }
      const requirement = p.requirementId as { sourceIndex?: number } | undefined;
      if (requirement?.sourceIndex !== 1) {
        respondError(id, -32602, "Invalid params: approval/decide params", "invalidParams");
        return;
      }
      respond(id, {
        approvalId: pending.approvalId,
        commandId: p.commandId,
        status: "accepted",
        terminal: true,
      });
      const approved = p.choiceId !== "abort";
      notify("approval/resolved", {
        sessionId: session.sessionId,
        approvalId: pending.approvalId,
        itemId: pending.approvalId,
        turnId: pending.turnId,
        decision: approved ? "approved" : "abort",
        resolvedBy: "user",
        policyResult: approved ? "allow" : "deny",
        viewCursor: cursor(session.sessionId),
        sourceRange: {},
        stageEvidence: [],
      });
      session.pendingApproval = null;
      if (approved) {
        emitToolCall(session, pending.turnId, pending.approvalId);
      }
      continueAfterGates(session, pending.turnId);
      return;
    }
    case "userInput/answer": {
      const session = sessions.get(String(p.sessionId));
      const pending = session?.pendingUserInput;
      if (!session || !pending || pending.userInputId !== p.userInputId) {
        respondError(id, -32000, "Unknown user input", "userInputNotFound");
        return;
      }
      respond(id, { commandId: p.commandId, status: "accepted" });
      notify("userInput/settled", {
        sessionId: session.sessionId,
        userInputId: pending.userInputId,
        outcome: "answered",
        answers: p.answers,
        clarification: null,
        decidedByCommandId: p.commandId,
        reason: null,
        viewCursor: cursor(session.sessionId),
        sourceRange: {},
      });
      session.pendingUserInput = null;
      userInputDone.add(pending.turnId);
      continueAfterGates(session, pending.turnId);
      return;
    }
    case "session/compact":
      respond(id, { commandId: p.commandId, status: "accepted" });
      return;
    default:
      respondError(id, -32601, `Method not found: ${method}`, "methodNotFound");
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        handle(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Ignore malformed frames, as the real host would.
      }
    }
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
