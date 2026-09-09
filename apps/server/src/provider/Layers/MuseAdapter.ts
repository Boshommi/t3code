/**
 * MuseAdapter — Muse Code (Meta) provider adapter over the Muse Session Protocol.
 *
 * One `muse serve` host per thread. The host persists sessions on disk, so
 * `resumeCursor` only needs the Muse session id; a restart reattaches through
 * `session/resume`. Approvals and questions are notifications answered by
 * client requests, so nothing here blocks a JSON-RPC reply.
 *
 * @module provider/Layers/MuseAdapter
 */
import {
  ApprovalRequestId,
  EventId,
  type CanonicalRequestType,
  type ModelSelection,
  type MuseSettings,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  type RuntimeMode,
  type ThreadTokenUsageSnapshot,
  ThreadId,
  type ToolLifecycleItemType,
  TurnId,
  type TurnTokenUsage,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import type { MuseAdapterShape } from "../Services/MuseAdapter.ts";
import {
  initializeMspConnection,
  makeMspConnection,
  makeUuidV7,
  type MspConnection,
  type MspError,
  type MspNotification,
  type MspTransportError,
  resolveMspModelRoute,
} from "../msp/MspConnection.ts";
import {
  type MspApprovalChoice,
  type MspApprovalMode,
  MspApprovalRequestedParams,
  MspApprovalResolvedParams,
  MspApprovalUpdatedParams,
  type MspApprovalRequirementRef,
  MspItemDeltaParams,
  MspItemLifecycleParams,
  type MspItem,
  type MspReasoningEffort,
  MspSessionContextUsageParams,
  MspSessionModelChangedParams,
  MspSessionResumeResult,
  MspSessionStartResult,
  MspSessionTodoListChangedParams,
  MspSessionTokenUsageParams,
  type MspTokenUsage,
  MspTurnCompletedParams,
  MspTurnStartResult,
  MspTurnStartedParams,
  type MspUserInputQuestion,
  MspUserInputRequestedParams,
  MspUserInputSettledParams,
  MSP_REASONING_EFFORTS,
} from "../msp/MspProtocol.ts";

const PROVIDER = ProviderDriverKind.make("muse");
const MUSE_RESUME_VERSION = 1;
const DEFAULT_CLIENT_VERSION = "0.0.0";

export interface MuseAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  readonly clientVersion?: string;
}

/**
 * T3 runtime modes map onto Muse's wire approval modes. `promptUnmatched` is
 * Muse's default posture: policy-safe actions (reads, workspace writes) run,
 * everything else asks. `onRequest` lets Muse's approval judge decide, which is
 * the closest thing to T3's automatic review. `allowAll` never asks.
 */
export function museApprovalModeForRuntimeMode(mode: RuntimeMode): MspApprovalMode {
  switch (mode) {
    case "approval-required":
    case "auto-accept-edits":
      return "promptUnmatched";
    case "auto":
      return "onRequest";
    case "full-access":
      return "allowAll";
  }
}

/**
 * Sandbox posture is fixed per host process, so it is decided at spawn. Only
 * full access drops Muse's OS sandbox; every other mode keeps it, which is why
 * a runtime mode change to or from full access restarts the host.
 */
export function museServeArgs(mode: RuntimeMode): ReadonlyArray<string> {
  return ["serve", "--trust-workspace", ...(mode === "full-access" ? ["--disable-sandbox"] : [])];
}

function museChoiceDecision(choice: MspApprovalChoice): ProviderApprovalDecision | undefined {
  switch (choice.decision) {
    case "approved":
      return choice.scope === "session"
        ? "acceptForSession"
        : choice.scope === "localPersistent"
          ? "acceptAlways"
          : "accept";
    case "approvedForSession":
      return "acceptForSession";
    case "approvedPolicyAmendment":
      return choice.scope === "session" ? "acceptForSession" : "acceptAlways";
    case "denied":
    case "deniedPolicyAmendment":
    case "abort":
      return "decline";
    default:
      return undefined;
  }
}

/** Muse's choices, reduced to the decisions T3 renders. First choice per decision wins. */
export function museApprovalOptions(
  choices: ReadonlyArray<MspApprovalChoice>,
): ReadonlyArray<ProviderApprovalOption> {
  const seen = new Set<ProviderApprovalDecision>();
  const options: Array<ProviderApprovalOption> = [];
  for (const choice of choices) {
    const decision = museChoiceDecision(choice);
    if (!decision || seen.has(decision)) continue;
    seen.add(decision);
    options.push({ decision, label: choice.label.trim() || decision });
  }
  return options;
}

/** Picks the Muse choice for a T3 decision, degrading to a narrower approval when the wider one is not offered. */
export function selectMuseChoiceId(
  choices: ReadonlyArray<MspApprovalChoice>,
  decision: ProviderApprovalDecision,
): string | undefined {
  const byDecision = new Map<ProviderApprovalDecision, string>();
  for (const choice of choices) {
    const mapped = museChoiceDecision(choice);
    if (mapped && !byDecision.has(mapped)) byDecision.set(mapped, choice.choiceId);
  }
  const preference: ReadonlyArray<ProviderApprovalDecision> =
    decision === "acceptAlways"
      ? ["acceptAlways", "acceptForSession", "accept"]
      : decision === "acceptForSession"
        ? ["acceptForSession", "accept"]
        : decision === "accept"
          ? ["accept", "acceptForSession", "acceptAlways"]
          : ["decline"];
  for (const candidate of preference) {
    const choiceId = byDecision.get(candidate);
    if (choiceId) return choiceId;
  }
  return undefined;
}

export function museRequestType(input: {
  readonly toolName?: string | undefined;
  readonly subject?:
    | {
        readonly kind: string;
        readonly command?: string | undefined;
        readonly path?: string | undefined;
      }
    | undefined;
  readonly protectedWrite?: boolean | undefined;
}): CanonicalRequestType {
  const kind = `${input.subject?.kind ?? ""} ${input.toolName ?? ""}`.toLowerCase();
  if (input.subject?.command !== undefined || /shell|command|exec|bash/.test(kind)) {
    return "exec_command_approval";
  }
  if (input.protectedWrite || /write|edit|patch|delete|move|create/.test(kind)) {
    return "file_change_approval";
  }
  if (/read|glob|grep|list/.test(kind)) {
    return "file_read_approval";
  }
  return "dynamic_tool_call";
}

export function museToolItemType(tool: string | undefined): ToolLifecycleItemType {
  const name = (tool ?? "").toLowerCase();
  if (/shell|bash|exec|command|run_/.test(name)) return "command_execution";
  if (/write|edit|patch|create|delete|move|rename|mkdir/.test(name)) return "file_change";
  if (/web|fetch|search|browse|http/.test(name)) return "web_search";
  if (name.includes("mcp") || name.includes("__")) return "mcp_tool_call";
  return "dynamic_tool_call";
}

const MuseResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(MUSE_RESUME_VERSION),
  sessionId: Schema.String.check(Schema.isNonEmpty()),
});
const decodeResumeCursor = Schema.decodeUnknownOption(MuseResumeCursor);

export function parseMuseResume(cursor: unknown): { readonly sessionId: string } | undefined {
  const decoded = decodeResumeCursor(cursor);
  return Option.isSome(decoded) ? { sessionId: decoded.value.sessionId } : undefined;
}

function parseJsonRecord(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toolDetail(
  itemType: ToolLifecycleItemType,
  tool: string | undefined,
  args: unknown,
): string | undefined {
  const record =
    typeof args === "object" && args !== null ? (args as Record<string, unknown>) : undefined;
  const pick = (...keys: ReadonlyArray<string>) => {
    for (const key of keys) {
      const value = record?.[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  };
  switch (itemType) {
    case "command_execution":
      return pick("command", "cmd", "script") ?? tool;
    case "file_change":
    case "web_search":
      return pick("path", "file_path", "filePath", "url", "query") ?? tool;
    default:
      return pick("path", "query", "command") ?? tool;
  }
}

function turnTokenUsageFromMsp(usage: MspTokenUsage | undefined): TurnTokenUsage | undefined {
  if (!usage) return undefined;
  const common = {
    usageScope: "main_agent" as const,
    hasSubagents: false,
    ...(usage.cachedTokens !== undefined ? { cachedInputTokens: usage.cachedTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined
      ? { cacheCreationTokens: usage.cacheWriteTokens }
      : {}),
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
  };
  if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
    return {
      ...common,
      usageStatus: "complete",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
  }
  return {
    ...common,
    usageStatus: "partial",
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
  };
}

export function museUserInputQuestions(
  questions: ReadonlyArray<MspUserInputQuestion>,
): ReadonlyArray<UserInputQuestion> {
  return questions.map((question) => ({
    id: question.id,
    header: nonEmpty(question.header) ?? "Question",
    question: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description ?? "",
    })),
    allowCustomAnswer: true,
    multiSelect: question.selection?.mode === "multiple",
  }));
}

function answerValues(answer: unknown): ReadonlyArray<string> {
  if (Array.isArray(answer)) {
    return answer.flatMap((entry) =>
      typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
    );
  }
  return typeof answer === "string" && answer.trim() ? [answer.trim()] : [];
}

/** T3 answers are keyed by question id (or text) and hold a label, a free-text string, or a list. */
export function museUserInputAnswers(
  questions: ReadonlyArray<MspUserInputQuestion>,
  answers: ProviderUserInputAnswers,
): ReadonlyArray<{
  readonly questionId: string;
  readonly selectedLabel?: string;
  readonly selectedLabels?: ReadonlyArray<string>;
  readonly freeText?: string;
}> {
  return questions.flatMap((question) => {
    const values = answerValues(answers[question.id] ?? answers[question.question]);
    if (values.length === 0) return [];
    const labels = new Set(question.options.map((option) => option.label));
    const selected = values.filter((value) => labels.has(value));
    const freeText = values.filter((value) => !labels.has(value)).join("\n");
    if (question.selection?.mode === "multiple") {
      return [
        {
          questionId: question.id,
          ...(selected.length > 0 ? { selectedLabels: selected } : {}),
          ...(freeText ? { freeText } : {}),
        },
      ];
    }
    return [
      {
        questionId: question.id,
        ...(selected[0] !== undefined ? { selectedLabel: selected[0] } : {}),
        ...(freeText ? { freeText } : {}),
      },
    ];
  });
}

function normalizeReasoningEffort(value: string | undefined): MspReasoningEffort | undefined {
  return value !== undefined && (MSP_REASONING_EFFORTS as ReadonlyArray<string>).includes(value)
    ? (value as MspReasoningEffort)
    : undefined;
}

interface PendingApproval {
  readonly approvalId: string;
  readonly turnId: TurnId;
  readonly requestType: CanonicalRequestType;
  readonly toolCallId: string | undefined;
  readonly detail: string;
  readonly args: unknown;
  requirement: MspApprovalRequirementRef;
  choices: ReadonlyArray<MspApprovalChoice>;
  answered: boolean;
}

interface PendingUserInput {
  readonly userInputId: string;
  readonly turnId: TurnId;
  readonly questions: ReadonlyArray<MspUserInputQuestion>;
  answered: boolean;
}

interface TrackedItem {
  readonly runtimeItemId: RuntimeItemId;
  readonly kind: string;
  readonly itemType: ToolLifecycleItemType | "assistant_message" | "reasoning";
  readonly turnId: TurnId | undefined;
  started: boolean;
  completed: boolean;
}

interface MuseSessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly connection: MspConnection;
  readonly museSessionId: string;
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  stopped: boolean;
  currentModelId: string | undefined;
  contextWindowTokens: number | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly items: Map<string, TrackedItem>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningOutputTokens: number;
    usedTokens: number;
  };
}

export const makeMuseAdapter = Effect.fn("makeMuseAdapter")(function* (
  museSettings: MuseSettings,
  options?: MuseAdapterLiveOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("muse");
  const environment = options?.environment ?? process.env;
  const nativeEventLogger = options?.nativeEventLogger;
  const clientVersion = options?.clientVersion ?? DEFAULT_CLIENT_VERSION;

  const sessions = new Map<ThreadId, MuseSessionContext>();
  const threadLocks = new Map<ThreadId, Semaphore.Semaphore>();
  const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate Muse runtime identifier.",
          cause,
        }),
    ),
  );
  const stamp = () =>
    Effect.all({ eventId: Effect.map(randomUUIDv4, EventId.make), createdAt: nowIso });
  const emit = (event: ProviderRuntimeEvent) =>
    PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid);
  const logNative = (threadId: ThreadId, event: Record<string, unknown>) =>
    nativeEventLogger
      ? nowIso.pipe(
          Effect.flatMap((observedAt) => nativeEventLogger.write({ observedAt, event }, threadId)),
        )
      : Effect.void;

  const withThreadLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      let semaphore = threadLocks.get(threadId);
      if (!semaphore) {
        semaphore = yield* Semaphore.make(1);
        threadLocks.set(threadId, semaphore);
      }
      return yield* semaphore.withPermits(1)(effect);
    });

  const toRequestError = (method: string) => (cause: MspError) =>
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail: cause.message,
      cause,
    });

  const commandId = () =>
    makeUuidV7().pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomBytes",
            detail: "Failed to generate Muse command identifier.",
            cause,
          }),
      ),
    );

  const ensureContext = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
      }
      return ctx;
    });

  const updateSession = (ctx: MuseSessionContext, patch: Partial<ProviderSession>) =>
    nowIso.pipe(
      Effect.map((updatedAt) => {
        ctx.session = { ...ctx.session, ...patch, updatedAt };
        return ctx.session;
      }),
    );

  const emitTokenUsage = (ctx: MuseSessionContext) =>
    Effect.gen(function* () {
      const usage: ThreadTokenUsageSnapshot = {
        usedTokens: ctx.usage.usedTokens,
        inputTokens: ctx.usage.inputTokens,
        outputTokens: ctx.usage.outputTokens,
        cachedInputTokens: ctx.usage.cachedInputTokens,
        reasoningOutputTokens: ctx.usage.reasoningOutputTokens,
        ...(ctx.contextWindowTokens !== undefined ? { maxTokens: ctx.contextWindowTokens } : {}),
      };
      yield* emit({
        type: "thread.token-usage.updated",
        ...(yield* stamp()),
        provider: PROVIDER,
        threadId: ctx.threadId,
        ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
        payload: { usage },
      });
    });

  const settlePendingForTurn = (ctx: MuseSessionContext, turnId: TurnId | undefined) =>
    Effect.gen(function* () {
      for (const [requestId, pending] of ctx.pendingApprovals) {
        if (turnId !== undefined && pending.turnId !== turnId) continue;
        ctx.pendingApprovals.delete(requestId);
        if (pending.answered) continue;
        yield* emit({
          type: "request.resolved",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId: pending.turnId,
          requestId: RuntimeRequestId.make(requestId),
          payload: { requestType: pending.requestType, decision: "cancel" },
        });
      }
      for (const [requestId, pending] of ctx.pendingUserInputs) {
        if (turnId !== undefined && pending.turnId !== turnId) continue;
        ctx.pendingUserInputs.delete(requestId);
        if (pending.answered) continue;
        yield* emit({
          type: "user-input.resolved",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId: pending.turnId,
          requestId: RuntimeRequestId.make(requestId),
          payload: { answers: {} },
        });
      }
    });

  const completeTurn = (
    ctx: MuseSessionContext,
    turnId: TurnId,
    payload: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>["payload"],
  ) =>
    Effect.gen(function* () {
      if (ctx.activeTurnId === turnId) {
        ctx.activeTurnId = undefined;
      }
      yield* settlePendingForTurn(ctx, turnId);
      for (const [museItemId, item] of ctx.items) {
        if (item.turnId === turnId) ctx.items.delete(museItemId);
      }
      yield* updateSession(ctx, {
        status: ctx.stopped ? "closed" : "ready",
        activeTurnId: undefined,
      });
      yield* emit({
        type: "turn.completed",
        ...(yield* stamp()),
        provider: PROVIDER,
        threadId: ctx.threadId,
        turnId,
        payload,
      });
    });

  // ── Item mapping ──────────────────────────────────────────────────────

  const trackItem = (ctx: MuseSessionContext, item: MspItem): TrackedItem | undefined => {
    const existing = ctx.items.get(item.itemId);
    if (existing) return existing;
    const turnId = item.turnId ? TurnId.make(item.turnId) : ctx.activeTurnId;
    let itemType: TrackedItem["itemType"];
    switch (item.kind) {
      case "agentMessage":
        itemType = "assistant_message";
        break;
      case "reasoning":
        itemType = "reasoning";
        break;
      case "toolCall":
      case "userShell":
        itemType = museToolItemType(item.tool ?? (item.kind === "userShell" ? "shell" : undefined));
        break;
      default:
        return undefined;
    }
    const tracked: TrackedItem = {
      runtimeItemId: RuntimeItemId.make(item.itemId),
      kind: item.kind,
      itemType,
      turnId,
      started: false,
      completed: false,
    };
    ctx.items.set(item.itemId, tracked);
    return tracked;
  };

  const itemStatus = (status: string): "inProgress" | "completed" | "failed" | "declined" => {
    switch (status) {
      case "inProgress":
        return "inProgress";
      case "completed":
        return "completed";
      case "rejected":
        return "declined";
      default:
        return "failed";
    }
  };

  const handleItemLifecycle = (
    ctx: MuseSessionContext,
    lifecycle: "started" | "updated" | "completed",
    params: MspItemLifecycleParams,
    raw: unknown,
  ) =>
    Effect.gen(function* () {
      const item = params.item;
      if (item.kind === "subagent") {
        yield* handleSubagentItem(ctx, lifecycle, item, raw);
        return;
      }
      if (item.kind === "compaction") {
        if (lifecycle !== "completed") return;
        yield* emit({
          type: "thread.state.changed",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
          payload: {
            state: "compacted",
            ...(item.tokensBefore !== undefined ? { beforeTokens: item.tokensBefore } : {}),
            ...(item.tokensAfter !== undefined ? { afterTokens: item.tokensAfter } : {}),
          },
          raw: { source: "msp.jsonrpc", method: "item/completed", payload: raw },
        });
        return;
      }
      const tracked = trackItem(ctx, item);
      if (!tracked) return;
      const terminal = lifecycle === "completed" || item.status !== "inProgress";
      if (tracked.completed) return;
      const status = terminal ? itemStatus(item.status) : "inProgress";

      if (tracked.itemType === "assistant_message" || tracked.itemType === "reasoning") {
        if (!tracked.started) {
          tracked.started = true;
          yield* emit({
            type: "item.started",
            ...(yield* stamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            ...(tracked.turnId ? { turnId: tracked.turnId } : {}),
            itemId: tracked.runtimeItemId,
            payload: { itemType: tracked.itemType, status: "inProgress" },
          });
        }
        if (!terminal) return;
        tracked.completed = true;
        const text = item.text ?? "";
        if (tracked.turnId) {
          const turn = ctx.turns.find((entry) => entry.id === tracked.turnId);
          turn?.items.push({ kind: item.kind, itemId: item.itemId, text });
        }
        yield* emit({
          type: "item.completed",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          ...(tracked.turnId ? { turnId: tracked.turnId } : {}),
          itemId: tracked.runtimeItemId,
          payload: {
            itemType: tracked.itemType,
            status,
            data: { text },
          },
          raw: { source: "msp.jsonrpc", method: `item/${lifecycle}`, payload: raw },
        });
        return;
      }

      const rawInput = parseJsonRecord(item.args);
      const detail = toolDetail(tracked.itemType, item.tool, rawInput);
      const data: Record<string, unknown> = {
        toolCallId: item.itemId,
        ...(item.tool ? { tool: item.tool } : {}),
        ...(rawInput !== undefined ? { rawInput } : {}),
      };
      if (tracked.itemType === "command_execution" && detail) {
        data.command = detail;
      }
      if (item.visibleOutput !== undefined) {
        data.rawOutput = item.visibleOutput;
      }
      if (item.exitCode !== undefined) {
        data.exitCode = item.exitCode;
      }
      if (item.failureReason) {
        data.error = item.failureReason;
      }
      const type = !tracked.started ? "item.started" : terminal ? "item.completed" : "item.updated";
      tracked.started = true;
      if (terminal) {
        tracked.completed = true;
        if (tracked.turnId) {
          const turn = ctx.turns.find((entry) => entry.id === tracked.turnId);
          turn?.items.push({
            kind: item.kind,
            itemId: item.itemId,
            tool: item.tool,
            args: rawInput,
          });
        }
      }
      yield* emit({
        type,
        ...(yield* stamp()),
        provider: PROVIDER,
        threadId: ctx.threadId,
        ...(tracked.turnId ? { turnId: tracked.turnId } : {}),
        itemId: tracked.runtimeItemId,
        payload: {
          itemType: tracked.itemType,
          status,
          ...(item.tool ? { title: item.tool } : {}),
          ...(detail ? { detail } : {}),
          data,
        },
        raw: { source: "msp.jsonrpc", method: `item/${lifecycle}`, payload: raw },
      });
      // A tool that started and completed in one frame still needs its terminal event.
      if (type === "item.started" && terminal) {
        yield* emit({
          type: "item.completed",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          ...(tracked.turnId ? { turnId: tracked.turnId } : {}),
          itemId: tracked.runtimeItemId,
          payload: {
            itemType: tracked.itemType,
            status,
            ...(item.tool ? { title: item.tool } : {}),
            ...(detail ? { detail } : {}),
            data,
          },
        });
      }
    });

  const handleSubagentItem = (
    ctx: MuseSessionContext,
    lifecycle: "started" | "updated" | "completed",
    item: MspItem,
    raw: unknown,
  ) =>
    Effect.gen(function* () {
      const taskId = RuntimeTaskId.make(item.subagentId ?? item.itemId);
      const description = nonEmpty(item.objective) ?? nonEmpty(item.displayText) ?? "Subagent";
      const turnId = item.turnId ? TurnId.make(item.turnId) : ctx.activeTurnId;
      const linkage = {
        taskType: "subagent",
        agentKind: "agent" as const,
        ...(item.agentPath ? { agentPath: item.agentPath } : {}),
      };
      const base = {
        ...(yield* stamp()),
        provider: PROVIDER,
        threadId: ctx.threadId,
        ...(turnId ? { turnId } : {}),
        raw: { source: "msp.jsonrpc" as const, method: `item/${lifecycle}`, payload: raw },
      };
      const terminal = lifecycle === "completed" || item.status !== "inProgress";
      if (lifecycle === "started") {
        yield* emit({
          type: "task.started",
          ...base,
          payload: { taskId, description, ...linkage },
        });
        if (!terminal) return;
      }
      if (!terminal) {
        yield* emit({
          type: "task.progress",
          ...base,
          payload: { taskId, description, ...linkage },
        });
        return;
      }
      const summary = nonEmpty(item.result?.summary) ?? nonEmpty(item.text);
      yield* emit({
        type: "task.completed",
        ...base,
        payload: {
          taskId,
          status:
            item.status === "completed"
              ? "completed"
              : item.status === "cancelled"
                ? "stopped"
                : "failed",
          ...(summary ? { summary } : {}),
          ...linkage,
        },
      });
    });

  const handleItemDelta = (ctx: MuseSessionContext, params: MspItemDeltaParams) =>
    Effect.gen(function* () {
      const tracked = ctx.items.get(params.itemId);
      if (!tracked || tracked.completed) return;
      if (params.field !== undefined && params.field !== "text") return;
      if (tracked.itemType !== "assistant_message" && tracked.itemType !== "reasoning") return;
      yield* emit({
        type: "content.delta",
        ...(yield* stamp()),
        provider: PROVIDER,
        threadId: ctx.threadId,
        ...(tracked.turnId ? { turnId: tracked.turnId } : {}),
        itemId: tracked.runtimeItemId,
        payload: {
          streamKind:
            tracked.itemType === "assistant_message" ? "assistant_text" : "reasoning_text",
          delta: params.delta,
        },
      });
    });

  // ── Approvals and questions ───────────────────────────────────────────

  const openApproval = (
    ctx: MuseSessionContext,
    pending: Omit<PendingApproval, "answered">,
    raw: unknown,
    method: string,
  ) =>
    Effect.gen(function* () {
      const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
      ctx.pendingApprovals.set(requestId, { ...pending, answered: false });
      const { turnId, requestType, detail, args } = pending;
      yield* updateSession(ctx, { status: "running" });
      yield* emit({
        type: "request.opened",
        ...(yield* stamp()),
        provider: PROVIDER,
        threadId: ctx.threadId,
        turnId,
        requestId: RuntimeRequestId.make(requestId),
        providerRefs: {
          providerRequestId: pending.approvalId,
          ...(pending.toolCallId
            ? { providerItemId: ProviderItemId.make(pending.toolCallId) }
            : {}),
        },
        payload: {
          requestType,
          detail,
          options: museApprovalOptions(pending.choices),
          ...(args !== undefined ? { args } : {}),
        },
        raw: { source: "msp.jsonrpc", method, payload: raw },
      });
    });

  const handleApprovalRequested = (
    ctx: MuseSessionContext,
    params: MspApprovalRequestedParams,
    raw: unknown,
  ) =>
    openApproval(
      ctx,
      {
        approvalId: params.approvalId,
        turnId: TurnId.make(params.turnId),
        requestType: museRequestType(params),
        toolCallId: params.toolCallId,
        detail:
          nonEmpty(params.subject?.command) ??
          nonEmpty(params.subject?.path) ??
          nonEmpty(params.subject?.target) ??
          nonEmpty(params.subject?.host) ??
          nonEmpty(params.toolName) ??
          nonEmpty(params.subject?.kind) ??
          "Tool call",
        args: parseJsonRecord(params.rawArgs),
        requirement: params.currentRequirementId,
        choices: params.availableChoices,
      },
      raw,
      "approval/requested",
    );

  const findPendingApproval = (ctx: MuseSessionContext, approvalId: string) => {
    for (const [requestId, pending] of ctx.pendingApprovals) {
      if (pending.approvalId === approvalId) return { requestId, pending };
    }
    return undefined;
  };

  const handleApprovalUpdated = (
    ctx: MuseSessionContext,
    params: MspApprovalUpdatedParams,
    raw: unknown,
  ) =>
    Effect.gen(function* () {
      const found = findPendingApproval(ctx, params.approvalId);
      if (!found) return;
      if (params.currentRequirementId) found.pending.requirement = params.currentRequirementId;
      if (params.availableChoices) found.pending.choices = params.availableChoices;
      // A multi-stage approval asks again after the first stage is granted. The
      // previous request is already resolved on T3's side, so open a new one.
      if (found.pending.answered && params.currentRequirementId) {
        ctx.pendingApprovals.delete(found.requestId);
        const { answered: _answered, ...stage } = found.pending;
        yield* openApproval(ctx, stage, raw, "approval/updated");
      }
    });

  const handleApprovalResolved = (ctx: MuseSessionContext, params: MspApprovalResolvedParams) =>
    Effect.gen(function* () {
      const found = findPendingApproval(ctx, params.approvalId);
      if (!found) return;
      ctx.pendingApprovals.delete(found.requestId);
      if (found.pending.answered) return;
      const decision: ProviderApprovalDecision = params.decision.startsWith("approved")
        ? "accept"
        : "decline";
      yield* emit({
        type: "request.resolved",
        ...(yield* stamp()),
        provider: PROVIDER,
        threadId: ctx.threadId,
        turnId: found.pending.turnId,
        requestId: RuntimeRequestId.make(found.requestId),
        payload: {
          requestType: found.pending.requestType,
          decision,
          resolution: { resolvedBy: params.resolvedBy, decision: params.decision },
        },
      });
    });

  const openUserInput = (
    ctx: MuseSessionContext,
    params: MspUserInputRequestedParams,
    raw: unknown,
  ) =>
    Effect.gen(function* () {
      const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
      const turnId = TurnId.make(params.turnId);
      ctx.pendingUserInputs.set(requestId, {
        userInputId: params.userInputId,
        turnId,
        questions: params.questions,
        answered: false,
      });
      yield* updateSession(ctx, { status: "running" });
      yield* emit({
        type: "user-input.requested",
        ...(yield* stamp()),
        provider: PROVIDER,
        threadId: ctx.threadId,
        turnId,
        requestId: RuntimeRequestId.make(requestId),
        providerRefs: { providerRequestId: params.userInputId },
        payload: { questions: museUserInputQuestions(params.questions) },
        raw: { source: "msp.jsonrpc", method: "userInput/requested", payload: raw },
      });
    });

  const handleUserInputSettled = (ctx: MuseSessionContext, params: MspUserInputSettledParams) =>
    Effect.gen(function* () {
      for (const [requestId, pending] of ctx.pendingUserInputs) {
        if (pending.userInputId !== params.userInputId) continue;
        ctx.pendingUserInputs.delete(requestId);
        if (pending.answered) return;
        yield* emit({
          type: "user-input.resolved",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId: pending.turnId,
          requestId: RuntimeRequestId.make(requestId),
          payload: { answers: {} },
        });
        return;
      }
    });

  // ── Notification dispatch ─────────────────────────────────────────────

  const decode = <A, I>(schema: Schema.Codec<A, I>, params: unknown) =>
    Schema.decodeUnknownOption(schema)(params);

  const handleNotification = (threadId: ThreadId, notification: MspNotification) =>
    Effect.gen(function* () {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) return;
      yield* logNative(threadId, { method: notification.method, params: notification.params });
      const params = notification.params;
      const sessionId =
        typeof params === "object" && params !== null && "sessionId" in params
          ? (params as { sessionId?: unknown }).sessionId
          : undefined;
      // Child sessions (subagents) share the host; only the thread's own session is a transcript.
      if (sessionId !== undefined && sessionId !== ctx.museSessionId) return;

      switch (notification.method) {
        case "item/started":
        case "item/updated":
        case "item/completed": {
          const decoded = decode(MspItemLifecycleParams, params);
          if (Option.isSome(decoded)) {
            yield* handleItemLifecycle(
              ctx,
              notification.method.slice("item/".length) as "started" | "updated" | "completed",
              decoded.value,
              params,
            );
          }
          return;
        }
        case "item/delta": {
          const decoded = decode(MspItemDeltaParams, params);
          if (Option.isSome(decoded)) yield* handleItemDelta(ctx, decoded.value);
          return;
        }
        case "turn/started": {
          const decoded = decode(MspTurnStartedParams, params);
          if (Option.isNone(decoded)) return;
          const turnId = TurnId.make(decoded.value.turnId);
          if (ctx.activeTurnId === turnId) return;
          // A queued follow-up started on its own; announce it so the turn can settle.
          ctx.activeTurnId = turnId;
          ctx.turns.push({ id: turnId, items: [] });
          yield* updateSession(ctx, { status: "running", activeTurnId: turnId });
          yield* emit({
            type: "turn.started",
            ...(yield* stamp()),
            provider: PROVIDER,
            threadId,
            turnId,
            payload: ctx.currentModelId ? { model: ctx.currentModelId } : {},
            raw: { source: "msp.jsonrpc", method: "turn/started", payload: params },
          });
          return;
        }
        case "turn/completed": {
          const decoded = decode(MspTurnCompletedParams, params);
          if (Option.isNone(decoded)) return;
          const turnId = TurnId.make(decoded.value.turnId);
          const terminal = decoded.value.terminal;
          const errorMessage =
            nonEmpty(decoded.value.error?.message) ?? nonEmpty(decoded.value.reason);
          const tokenUsage = turnTokenUsageFromMsp(decoded.value.usage);
          yield* completeTurn(ctx, turnId, {
            state:
              terminal === "completed"
                ? "completed"
                : terminal === "cancelled"
                  ? "cancelled"
                  : "failed",
            ...(terminal !== "completed" && errorMessage ? { errorMessage } : {}),
            ...(terminal === "completed" ? { stopReason: "end_turn" } : {}),
            ...(tokenUsage ? { tokenUsage } : {}),
          });
          return;
        }
        case "approval/requested": {
          const decoded = decode(MspApprovalRequestedParams, params);
          if (Option.isSome(decoded)) yield* handleApprovalRequested(ctx, decoded.value, params);
          return;
        }
        case "approval/updated": {
          const decoded = decode(MspApprovalUpdatedParams, params);
          if (Option.isSome(decoded)) yield* handleApprovalUpdated(ctx, decoded.value, params);
          return;
        }
        case "approval/resolved": {
          const decoded = decode(MspApprovalResolvedParams, params);
          if (Option.isSome(decoded)) yield* handleApprovalResolved(ctx, decoded.value);
          return;
        }
        case "userInput/requested": {
          const decoded = decode(MspUserInputRequestedParams, params);
          if (Option.isSome(decoded)) yield* openUserInput(ctx, decoded.value, params);
          return;
        }
        case "userInput/settled": {
          const decoded = decode(MspUserInputSettledParams, params);
          if (Option.isSome(decoded)) yield* handleUserInputSettled(ctx, decoded.value);
          return;
        }
        case "session/tokenUsage": {
          const decoded = decode(MspSessionTokenUsageParams, params);
          if (Option.isNone(decoded)) return;
          const value = decoded.value;
          if (value.cumulative?.promptTokens !== undefined)
            ctx.usage.inputTokens = value.cumulative.promptTokens;
          if (value.cumulative?.outputTokens !== undefined)
            ctx.usage.outputTokens = value.cumulative.outputTokens;
          if (value.usage?.cachedTokens !== undefined)
            ctx.usage.cachedInputTokens += value.usage.cachedTokens;
          if (value.usage?.reasoningTokens !== undefined)
            ctx.usage.reasoningOutputTokens += value.usage.reasoningTokens;
          if (value.promptTokens !== undefined) ctx.usage.usedTokens = value.promptTokens;
          yield* emitTokenUsage(ctx);
          return;
        }
        case "session/contextUsage": {
          const decoded = decode(MspSessionContextUsageParams, params);
          if (Option.isNone(decoded)) return;
          ctx.usage.usedTokens = decoded.value.usedTokens;
          if (decoded.value.windowTokens !== undefined && decoded.value.windowTokens > 0) {
            ctx.contextWindowTokens = decoded.value.windowTokens;
          }
          yield* emitTokenUsage(ctx);
          return;
        }
        case "session/modelChanged": {
          const decoded = decode(MspSessionModelChangedParams, params);
          if (Option.isNone(decoded)) return;
          const modelId = nonEmpty(decoded.value.modelId) ?? nonEmpty(decoded.value.model?.modelId);
          if (modelId) {
            ctx.currentModelId = modelId;
            yield* updateSession(ctx, { model: modelId });
          }
          return;
        }
        case "session/todoListChanged": {
          const decoded = decode(MspSessionTodoListChangedParams, params);
          if (Option.isNone(decoded)) return;
          const plan = decoded.value.items.flatMap((item) => {
            const step = nonEmpty(item.content) ?? nonEmpty(item.text) ?? nonEmpty(item.title);
            if (!step) return [];
            const status =
              item.status === "completed" || item.status === "done"
                ? "completed"
                : item.status === "inProgress" || item.status === "in_progress"
                  ? "inProgress"
                  : "pending";
            return [{ step, status } as const];
          });
          yield* emit({
            type: "turn.plan.updated",
            ...(yield* stamp()),
            provider: PROVIDER,
            threadId,
            ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
            payload: { plan },
            raw: { source: "msp.jsonrpc", method: "session/todoListChanged", payload: params },
          });
          return;
        }
        default:
          return;
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Muse notification handling failed.", {
          method: notification.method,
          cause,
        }),
      ),
    );

  // ── Host lifecycle ────────────────────────────────────────────────────

  const handleTermination = (threadId: ThreadId, error: MspTransportError) =>
    Effect.gen(function* () {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) return;
      ctx.stopped = true;
      sessions.delete(threadId);
      const activeTurnId = ctx.activeTurnId;
      if (activeTurnId) {
        yield* completeTurn(ctx, activeTurnId, { state: "failed", errorMessage: error.message });
      } else {
        yield* settlePendingForTurn(ctx, undefined);
      }
      yield* updateSession(ctx, {
        status: "error",
        lastError: error.message,
        activeTurnId: undefined,
      });
      yield* emit({
        type: "session.exited",
        ...(yield* stamp()),
        provider: PROVIDER,
        threadId,
        payload: { reason: error.message, recoverable: true, exitKind: "error" },
      });
      yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Muse host termination handling failed.", { threadId, cause }),
      ),
    );

  const stopContext = (ctx: MuseSessionContext) =>
    Effect.gen(function* () {
      if (ctx.stopped) return;
      ctx.stopped = true;
      sessions.delete(ctx.threadId);
      yield* settlePendingForTurn(ctx, undefined);
      yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
      yield* updateSession(ctx, { status: "closed", activeTurnId: undefined });
      yield* emit({
        type: "session.exited",
        ...(yield* stamp()),
        provider: PROVIDER,
        threadId: ctx.threadId,
        payload: { exitKind: "graceful" },
      });
    });

  const applyModelSelection = (
    ctx: MuseSessionContext,
    modelSelection: ModelSelection | undefined,
  ) =>
    Effect.gen(function* () {
      const requested = nonEmpty(modelSelection?.model);
      if (!requested || requested === ctx.currentModelId) return;
      const model = yield* resolveMspModelRoute(ctx.connection, requested).pipe(
        Effect.mapError(toRequestError("model/list")),
      );
      yield* ctx.connection
        .request(
          "session/setModel",
          {
            commandId: yield* commandId(),
            sessionId: ctx.museSessionId,
            model,
          },
          Schema.Unknown,
        )
        .pipe(Effect.mapError(toRequestError("session/setModel")));
      ctx.currentModelId = requested;
      yield* updateSession(ctx, { model: requested });
    });

  const startSession: MuseAdapterShape["startSession"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}', received '${input.provider}'.`,
          });
        }
        const cwd = input.cwd ?? serverConfig.cwd;
        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* stopContext(existing);
        }
        const resume = parseMuseResume(input.resumeCursor);
        const scope = yield* Scope.make("sequential");
        const started = yield* Effect.gen(function* () {
          const connection = yield* makeMspConnection({
            command: museSettings.binaryPath || "muse",
            args: museServeArgs(input.runtimeMode),
            cwd,
            env: environment,
            onNotification: (notification) => handleNotification(input.threadId, notification),
            onStderr: (chunk) => logNative(input.threadId, { stderr: chunk }),
            onTermination: (error) => handleTermination(input.threadId, error),
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(Scope.Scope, scope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          yield* initializeMspConnection(connection, clientVersion).pipe(
            Effect.mapError(toRequestError("initialize")),
          );
          const approvalMode = museApprovalModeForRuntimeMode(input.runtimeMode);
          const requestedModel = nonEmpty(input.modelSelection?.model);
          const session = resume
            ? yield* connection
                .request(
                  "session/resume",
                  {
                    commandId: yield* commandId(),
                    sessionId: resume.sessionId,
                    excludeItems: true,
                  },
                  MspSessionResumeResult,
                )
                .pipe(Effect.mapError(toRequestError("session/resume")))
            : yield* connection
                .request(
                  "session/start",
                  {
                    commandId: yield* commandId(),
                    workspaceRoot: cwd,
                    approvalMode,
                    ...(requestedModel
                      ? yield* resolveMspModelRoute(connection, requestedModel).pipe(
                          Effect.mapError(toRequestError("model/list")),
                        )
                      : {}),
                  },
                  MspSessionStartResult,
                )
                .pipe(Effect.mapError(toRequestError("session/start")));
          return { connection, session: session.session };
        }).pipe(Effect.tapError(() => Effect.ignore(Scope.close(scope, Exit.void))));

        const { connection, session: museSession } = started;
        const createdAt = yield* nowIso;
        const ctx: MuseSessionContext = {
          threadId: input.threadId,
          scope,
          connection,
          museSessionId: museSession.sessionId,
          cwd,
          runtimeMode: input.runtimeMode,
          session: {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(nonEmpty(museSession.modelId) ? { model: museSession.modelId!.trim() } : {}),
            threadId: input.threadId,
            resumeCursor: { schemaVersion: MUSE_RESUME_VERSION, sessionId: museSession.sessionId },
            createdAt,
            updatedAt: createdAt,
          },
          activeTurnId: undefined,
          stopped: false,
          currentModelId: nonEmpty(museSession.modelId),
          contextWindowTokens: undefined,
          pendingApprovals: new Map(),
          pendingUserInputs: new Map(),
          items: new Map(),
          turns: [],
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            reasoningOutputTokens: 0,
            usedTokens: 0,
          },
        };
        sessions.set(input.threadId, ctx);

        if (resume) {
          // The host reloads the durable log as-is. A turn that was running when the
          // previous host died must not silently continue under the new one.
          if (nonEmpty(museSession.activeTurnId)) {
            yield* connection
              .request(
                "turn/interrupt",
                {
                  commandId: yield* commandId(),
                  sessionId: ctx.museSessionId,
                  turnId: museSession.activeTurnId,
                },
                Schema.Unknown,
              )
              .pipe(Effect.ignore);
          }
          const currentMode = museSession.approvalMode?.mode;
          if (currentMode !== museApprovalModeForRuntimeMode(input.runtimeMode)) {
            yield* connection
              .request(
                "session/setApprovalMode",
                {
                  commandId: yield* commandId(),
                  sessionId: ctx.museSessionId,
                  mode: museApprovalModeForRuntimeMode(input.runtimeMode),
                },
                Schema.Unknown,
              )
              .pipe(Effect.ignore);
          }
        }
        yield* applyModelSelection(ctx, input.modelSelection);

        yield* emit({
          type: "session.started",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: resume ? { resume: { sessionId: ctx.museSessionId } } : {},
        });
        yield* emit({
          type: "session.state.changed",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { state: "ready" },
        });
        yield* emit({
          type: "thread.started",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { providerThreadId: ctx.museSessionId },
        });
        return ctx.session;
      }),
    );

  const sendTurn: MuseAdapterShape["sendTurn"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const ctx = yield* ensureContext(input.threadId);
        const text = nonEmpty(input.input);
        const imageParts = yield* Effect.forEach(
          (input.attachments ?? []).filter((attachment) => attachment.type === "image"),
          (attachment) =>
            Effect.gen(function* () {
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "turn/start",
                  detail: `Invalid attachment id '${attachment.id}'.`,
                });
              }
              const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "turn/start",
                      detail: cause.message,
                      cause,
                    }),
                ),
              );
              return {
                type: "image" as const,
                base64Data: Buffer.from(bytes).toString("base64"),
                mediaType: attachment.mimeType,
              };
            }),
        );
        const parts = [...(text ? [{ type: "text" as const, text }] : []), ...imageParts];
        if (parts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Muse turns require text input or at least one image attachment.",
          });
        }
        const modelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        yield* applyModelSelection(ctx, modelSelection);
        const reasoningEffort = normalizeReasoningEffort(
          getModelSelectionStringOptionValue(modelSelection, "reasoningEffort"),
        );
        const steering = ctx.activeTurnId !== undefined;
        const result = yield* ctx.connection
          .request(
            "turn/start",
            {
              commandId: yield* commandId(),
              sessionId: ctx.museSessionId,
              input: parts,
              ifBusy: steering ? "steer" : "queue",
              ...(reasoningEffort ? { reasoningEffort } : {}),
            },
            MspTurnStartResult,
          )
          .pipe(Effect.mapError(toRequestError("turn/start")));
        const turnId = TurnId.make(result.turnId);
        if (ctx.activeTurnId === undefined) {
          ctx.activeTurnId = turnId;
          ctx.turns.push({ id: turnId, items: [] });
          yield* updateSession(ctx, { status: "running", activeTurnId: turnId });
          yield* emit({
            type: "turn.started",
            ...(yield* stamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: {
              ...(ctx.currentModelId ? { model: ctx.currentModelId } : {}),
              ...(reasoningEffort ? { effort: reasoningEffort } : {}),
            },
            raw: { source: "msp.jsonrpc", method: "turn/start", payload: result },
          });
        }
        return {
          threadId: input.threadId,
          turnId: ctx.activeTurnId ?? turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      }),
    );

  const interruptTurn: MuseAdapterShape["interruptTurn"] = (threadId, turnId) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        const ctx = yield* ensureContext(threadId);
        const activeTurnId = ctx.activeTurnId;
        if (!activeTurnId || (turnId !== undefined && turnId !== activeTurnId)) return;
        yield* ctx.connection
          .request(
            "turn/interrupt",
            { commandId: yield* commandId(), sessionId: ctx.museSessionId, turnId: activeTurnId },
            Schema.Unknown,
          )
          .pipe(
            Effect.catchTag("MspRequestError", (error) =>
              // The turn already ended on the host; `turn/completed` settles it.
              error.kind === "notFound" || error.kind === "commandRejected"
                ? Effect.void
                : Effect.fail(error),
            ),
            Effect.mapError(toRequestError("turn/interrupt")),
          );
      }),
    );

  const respondToRequest: MuseAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.gen(function* () {
      const ctx = yield* ensureContext(threadId);
      const pending = ctx.pendingApprovals.get(requestId);
      if (!pending || pending.answered) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "approval/decide",
          detail: `Unknown or already answered approval request '${requestId}'.`,
        });
      }
      const choiceId = selectMuseChoiceId(pending.choices, decision);
      if (!choiceId) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "approval/decide",
          detail: `Muse offered no choice for decision '${decision}'.`,
        });
      }
      pending.answered = true;
      yield* ctx.connection
        .request(
          "approval/decide",
          {
            commandId: yield* commandId(),
            sessionId: ctx.museSessionId,
            approvalId: pending.approvalId,
            requirementId: pending.requirement,
            choiceId,
            feedback: null,
          },
          Schema.Unknown,
        )
        .pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              pending.answered = false;
            }),
          ),
          Effect.mapError(toRequestError("approval/decide")),
        );
      yield* emit({
        type: "request.resolved",
        ...(yield* stamp()),
        provider: PROVIDER,
        threadId,
        turnId: pending.turnId,
        requestId: RuntimeRequestId.make(requestId),
        payload: { requestType: pending.requestType, decision },
      });
    });

  const respondToUserInput: MuseAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.gen(function* () {
      const ctx = yield* ensureContext(threadId);
      const pending = ctx.pendingUserInputs.get(requestId);
      if (!pending || pending.answered) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "userInput/answer",
          detail: `Unknown or already answered user-input request '${requestId}'.`,
        });
      }
      pending.answered = true;
      yield* ctx.connection
        .request(
          "userInput/answer",
          {
            commandId: yield* commandId(),
            sessionId: ctx.museSessionId,
            userInputId: pending.userInputId,
            answers: museUserInputAnswers(pending.questions, answers),
          },
          Schema.Unknown,
        )
        .pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              pending.answered = false;
            }),
          ),
          Effect.mapError(toRequestError("userInput/answer")),
        );
      yield* emit({
        type: "user-input.resolved",
        ...(yield* stamp()),
        provider: PROVIDER,
        threadId,
        turnId: pending.turnId,
        requestId: RuntimeRequestId.make(requestId),
        payload: { answers },
      });
    });

  const compactionStart = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const ctx = yield* ensureContext(threadId);
      yield* ctx.connection
        .request(
          "session/compact",
          { commandId: yield* commandId(), sessionId: ctx.museSessionId },
          Schema.Unknown,
        )
        .pipe(Effect.mapError(toRequestError("session/compact")));
    });

  const stopSession: MuseAdapterShape["stopSession"] = (threadId) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx) return;
        yield* stopContext(ctx);
      }),
    );

  const listSessions: MuseAdapterShape["listSessions"] = () =>
    Effect.sync(() => [...sessions.values()].map((ctx) => ctx.session));

  const hasSession: MuseAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => sessions.has(threadId));

  const readThread: MuseAdapterShape["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const ctx = yield* ensureContext(threadId);
      return {
        threadId,
        turns: ctx.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
      };
    });

  const rollbackThread: MuseAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    Effect.gen(function* () {
      const ctx = yield* ensureContext(threadId);
      // Muse cannot rewind its conversation over the wire; only the local mirror shrinks.
      ctx.turns.splice(Math.max(0, ctx.turns.length - Math.max(0, numTurns)));
      return {
        threadId,
        turns: ctx.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
      };
    });

  const stopAll: MuseAdapterShape["stopAll"] = () =>
    Effect.forEach([...sessions.values()], (ctx) => Effect.ignore(stopContext(ctx)), {
      discard: true,
    });

  yield* Effect.addFinalizer(() =>
    Effect.ignore(stopAll()).pipe(Effect.ensuring(PubSub.shutdown(runtimeEvents))),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      promptlessTurnContinuation: false,
      supportsConversationRollback: false,
    },
    startSession,
    sendTurn,
    compaction: { type: "native", start: compactionStart },
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromPubSub(runtimeEvents),
  } satisfies MuseAdapterShape;
});

export type { ProviderAdapterError };
