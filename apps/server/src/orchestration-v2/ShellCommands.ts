/**
 * Shell commands (`!command`): one-shot commands the user runs from the
 * composer. Each is a run-less `command_execution` turn item: the Orchestrator
 * records it running, and ShellCommandReactor runs it and completes the same
 * item. It never touches the thread's runs or reaches the agent.
 */
import {
  type CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  TurnItemId,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

export type ShellCommandTurnItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "command_execution" }
>;

const ITEM_ID_PREFIX = "shell-command:";

export const shellCommandTurnItemId = (commandId: CommandId) =>
  TurnItemId.make(`${ITEM_ID_PREFIX}${commandId}`);

export const isShellCommandTurnItem = (
  item: OrchestrationV2TurnItem,
): item is ShellCommandTurnItem =>
  item.type === "command_execution" && item.runId === null && item.id.startsWith(ITEM_ID_PREFIX);

/**
 * Run-less items sort before every run unless placed in one's position range.
 * The latest run's range, queued runs included, puts the row after everything
 * already in the thread, so a client holding a partial timeline does not take
 * it for unloaded history.
 */
export function shellCommandRunOrdinal(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "ordinal">>,
): number | undefined {
  return runs.reduce<number | undefined>(
    (latest, run) => (latest === undefined || run.ordinal > latest ? run.ordinal : latest),
    undefined,
  );
}

export function runningShellCommandTurnItem(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "id">;
  readonly id: TurnItemId;
  readonly ordinal: number;
  readonly command: string;
  readonly now: DateTime.Utc;
}): ShellCommandTurnItem {
  return {
    id: input.id,
    threadId: input.thread.id,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "running",
    title: null,
    startedAt: input.now,
    completedAt: null,
    updatedAt: input.now,
    type: "command_execution",
    input: input.command,
  };
}
