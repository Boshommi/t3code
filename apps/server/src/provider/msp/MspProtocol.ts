/**
 * MspProtocol — the subset of Meta's Muse Session Protocol (MSP) T3 Code speaks.
 *
 * MSP is JSON-RPC 2.0 over the stdio of `muse serve`. The wire schema is
 * exported by `muse schema generate-ts`; these structs mirror only the fields
 * the adapter reads, and stay lenient so new fields never break decoding.
 *
 * @module provider/msp/MspProtocol
 */
import * as Schema from "effect/Schema";

export const MSP_CLIENT_NAME = "t3_code";

export const MspApprovalMode = Schema.Literals([
  "allowAll",
  "promptUnmatched",
  "onRequest",
  "denyUnmatched",
]);
export type MspApprovalMode = typeof MspApprovalMode.Type;

export const MspReasoningEffort = Schema.Literals([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultra",
]);
export type MspReasoningEffort = typeof MspReasoningEffort.Type;
export const MSP_REASONING_EFFORTS: ReadonlyArray<MspReasoningEffort> = MspReasoningEffort.literals;
export const MSP_DEFAULT_REASONING_EFFORT: MspReasoningEffort = "high";

export const MspInitializeResult = Schema.Struct({
  serverInfo: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      version: Schema.optional(Schema.String),
    }),
  ),
  museHome: Schema.optional(Schema.String),
  schema: Schema.optional(
    Schema.Struct({
      version: Schema.optional(Schema.Number),
      fingerprint: Schema.optional(Schema.String),
    }),
  ),
  sessionDurability: Schema.optional(Schema.String),
});
export type MspInitializeResult = typeof MspInitializeResult.Type;

const MspSession = Schema.Struct({
  sessionId: Schema.String,
  status: Schema.optional(Schema.String),
  modelId: Schema.optional(Schema.NullOr(Schema.String)),
  activeTurnId: Schema.optional(Schema.NullOr(Schema.String)),
  workspaceRoot: Schema.optional(Schema.NullOr(Schema.String)),
  turnCount: Schema.optional(Schema.Number),
  path: Schema.optional(Schema.String),
  approvalMode: Schema.optional(Schema.Struct({ mode: Schema.optional(Schema.String) })),
});

export const MspSessionStartResult = Schema.Struct({
  session: MspSession,
  viewCursor: Schema.optional(Schema.String),
});
export type MspSessionStartResult = typeof MspSessionStartResult.Type;

export const MspSessionResumeResult = Schema.Struct({
  session: MspSession,
  viewCursor: Schema.optional(Schema.String),
  pendingRequests: Schema.optional(Schema.Array(Schema.Unknown)),
  history: Schema.optional(
    Schema.Struct({
      mode: Schema.optional(Schema.String),
      items: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
    }),
  ),
});
export type MspSessionResumeResult = typeof MspSessionResumeResult.Type;

export const MspModelCatalogEntry = Schema.Struct({
  modelId: Schema.String,
  displayLabel: Schema.optional(Schema.String),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  isDefault: Schema.optional(Schema.Boolean),
  isActive: Schema.optional(Schema.Boolean),
  contextLimit: Schema.optional(Schema.NullOr(Schema.Number)),
  outputLimit: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type MspModelCatalogEntry = typeof MspModelCatalogEntry.Type;

export const MspModelListResult = Schema.Struct({
  models: Schema.Array(MspModelCatalogEntry),
  providerId: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
});
export type MspModelListResult = typeof MspModelListResult.Type;

export const MspTurnStartResult = Schema.Struct({
  turnId: Schema.String,
  commandId: Schema.optional(Schema.String),
  disposition: Schema.optional(Schema.String),
  startedNewTurn: Schema.optional(Schema.Boolean),
});
export type MspTurnStartResult = typeof MspTurnStartResult.Type;

export const MspTokenUsage = Schema.Struct({
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  cachedTokens: Schema.optional(Schema.Number),
  cacheReadTokens: Schema.optional(Schema.Number),
  cacheWriteTokens: Schema.optional(Schema.Number),
  reasoningTokens: Schema.optional(Schema.Number),
});
export type MspTokenUsage = typeof MspTokenUsage.Type;

export const MspItem = Schema.Struct({
  itemId: Schema.String,
  kind: Schema.String,
  status: Schema.String,
  revision: Schema.optional(Schema.Number),
  turnId: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  displayText: Schema.optional(Schema.String),
  tool: Schema.optional(Schema.String),
  args: Schema.optional(Schema.String),
  callId: Schema.optional(Schema.String),
  approvalId: Schema.optional(Schema.String),
  visibleOutput: Schema.optional(Schema.String),
  fallbackText: Schema.optional(Schema.String),
  failureReason: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  commandText: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number),
  summary: Schema.optional(Schema.Array(Schema.String)),
  objective: Schema.optional(Schema.String),
  childSessionId: Schema.optional(Schema.String),
  subagentId: Schema.optional(Schema.String),
  agentPath: Schema.optional(Schema.String),
  tokensBefore: Schema.optional(Schema.Number),
  tokensAfter: Schema.optional(Schema.Number),
  usage: Schema.optional(MspTokenUsage),
  result: Schema.optional(Schema.Struct({ summary: Schema.optional(Schema.String) })),
});
export type MspItem = typeof MspItem.Type;

export const MspItemLifecycleParams = Schema.Struct({
  sessionId: Schema.String,
  item: MspItem,
  viewCursor: Schema.optional(Schema.String),
});
export type MspItemLifecycleParams = typeof MspItemLifecycleParams.Type;

export const MspItemDeltaParams = Schema.Struct({
  sessionId: Schema.String,
  itemId: Schema.String,
  delta: Schema.String,
  field: Schema.optional(Schema.String),
});
export type MspItemDeltaParams = typeof MspItemDeltaParams.Type;

export const MspTurnStartedParams = Schema.Struct({
  sessionId: Schema.String,
  turnId: Schema.String,
  commandId: Schema.optional(Schema.String),
});
export type MspTurnStartedParams = typeof MspTurnStartedParams.Type;

const MspTurnError = Schema.Struct({
  kind: Schema.optional(Schema.String),
  message: Schema.String,
  retryable: Schema.optional(Schema.Boolean),
});

export const MspTurnCompletedParams = Schema.Struct({
  sessionId: Schema.String,
  turnId: Schema.String,
  terminal: Schema.String,
  reason: Schema.optional(Schema.String),
  error: Schema.optional(MspTurnError),
  durationMs: Schema.optional(Schema.Number),
  usage: Schema.optional(MspTokenUsage),
});
export type MspTurnCompletedParams = typeof MspTurnCompletedParams.Type;

export const MspApprovalChoice = Schema.Struct({
  choiceId: Schema.String,
  decision: Schema.String,
  label: Schema.String,
  scope: Schema.optional(Schema.String),
  rulePreview: Schema.optional(Schema.String),
  acceptsFeedback: Schema.optional(Schema.Boolean),
});
export type MspApprovalChoice = typeof MspApprovalChoice.Type;

export const MspApprovalRequirementRef = Schema.Struct({
  approvalId: Schema.String,
  sourceIndex: Schema.Number,
});
export type MspApprovalRequirementRef = typeof MspApprovalRequirementRef.Type;

const MspApprovalSubject = Schema.Struct({
  kind: Schema.String,
  command: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  target: Schema.optional(Schema.String),
  host: Schema.optional(Schema.String),
  access: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
});

export const MspApprovalRequestedParams = Schema.Struct({
  sessionId: Schema.String,
  turnId: Schema.String,
  approvalId: Schema.String,
  itemId: Schema.optional(Schema.String),
  toolCallId: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  rawArgs: Schema.optional(Schema.String),
  subject: Schema.optional(MspApprovalSubject),
  availableChoices: Schema.Array(MspApprovalChoice),
  currentRequirementId: MspApprovalRequirementRef,
  judgeEscalated: Schema.optional(Schema.Boolean),
  protectedWrite: Schema.optional(Schema.Boolean),
});
export type MspApprovalRequestedParams = typeof MspApprovalRequestedParams.Type;

export const MspApprovalUpdatedParams = Schema.Struct({
  sessionId: Schema.String,
  approvalId: Schema.String,
  currentRequirementId: Schema.optional(MspApprovalRequirementRef),
  availableChoices: Schema.optional(Schema.Array(MspApprovalChoice)),
});
export type MspApprovalUpdatedParams = typeof MspApprovalUpdatedParams.Type;

export const MspApprovalResolvedParams = Schema.Struct({
  sessionId: Schema.String,
  approvalId: Schema.String,
  decision: Schema.String,
  resolvedBy: Schema.optional(Schema.String),
  policyResult: Schema.optional(Schema.String),
});
export type MspApprovalResolvedParams = typeof MspApprovalResolvedParams.Type;

const MspUserInputOption = Schema.Struct({
  label: Schema.String,
  description: Schema.optional(Schema.String),
});

export const MspUserInputQuestion = Schema.Struct({
  id: Schema.String,
  header: Schema.optional(Schema.String),
  question: Schema.String,
  options: Schema.Array(MspUserInputOption),
  selection: Schema.optional(
    Schema.Struct({
      mode: Schema.optional(Schema.String),
      minSelections: Schema.optional(Schema.Number),
      maxSelections: Schema.optional(Schema.Number),
    }),
  ),
});
export type MspUserInputQuestion = typeof MspUserInputQuestion.Type;

export const MspUserInputRequestedParams = Schema.Struct({
  sessionId: Schema.String,
  turnId: Schema.String,
  userInputId: Schema.String,
  itemId: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  questions: Schema.Array(MspUserInputQuestion),
});
export type MspUserInputRequestedParams = typeof MspUserInputRequestedParams.Type;

export const MspUserInputSettledParams = Schema.Struct({
  sessionId: Schema.String,
  userInputId: Schema.String,
  outcome: Schema.String,
});
export type MspUserInputSettledParams = typeof MspUserInputSettledParams.Type;

export const MspSessionTokenUsageParams = Schema.Struct({
  sessionId: Schema.String,
  turnId: Schema.optional(Schema.String),
  promptTokens: Schema.optional(Schema.Number),
  totalTokens: Schema.optional(Schema.Number),
  modelId: Schema.optional(Schema.String),
  usage: Schema.optional(MspTokenUsage),
  cumulative: Schema.optional(
    Schema.Struct({
      promptTokens: Schema.optional(Schema.Number),
      outputTokens: Schema.optional(Schema.Number),
      totalTokens: Schema.optional(Schema.Number),
    }),
  ),
});
export type MspSessionTokenUsageParams = typeof MspSessionTokenUsageParams.Type;

export const MspSessionContextUsageParams = Schema.Struct({
  sessionId: Schema.String,
  usedTokens: Schema.Number,
  windowTokens: Schema.optional(Schema.Number),
  pressure: Schema.optional(Schema.String),
});
export type MspSessionContextUsageParams = typeof MspSessionContextUsageParams.Type;

export const MspSessionModelChangedParams = Schema.Struct({
  sessionId: Schema.String,
  modelId: Schema.optional(Schema.NullOr(Schema.String)),
  model: Schema.optional(Schema.Struct({ modelId: Schema.optional(Schema.String) })),
});
export type MspSessionModelChangedParams = typeof MspSessionModelChangedParams.Type;

const MspTodoItem = Schema.Struct({
  content: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
});

export const MspSessionTodoListChangedParams = Schema.Struct({
  sessionId: Schema.String,
  items: Schema.Array(MspTodoItem),
});
export type MspSessionTodoListChangedParams = typeof MspSessionTodoListChangedParams.Type;

/** Client-visible failure detail carried on a JSON-RPC error frame. */
export const MspErrorData = Schema.Struct({
  kind: Schema.optional(Schema.String),
  retryable: Schema.optional(Schema.Boolean),
  reason: Schema.optional(Schema.String),
});
