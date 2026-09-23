import type { MessageId, OrchestrationSideMessage } from "@t3tools/contracts";

/**
 * One side thread (`/btw`): the side messages sharing a `sideThreadId`, in
 * arrival order. The first message is the question that started it.
 */
export interface SideThread {
  readonly id: MessageId;
  readonly anchorMessageId: MessageId | null;
  readonly messages: ReadonlyArray<OrchestrationSideMessage>;
  /** Text of the opening question. */
  readonly question: string;
  readonly createdAt: string;
  /** When the newest message arrived. */
  readonly updatedAt: string;
  /** Messages after the opening question, Slack-style. */
  readonly replyCount: number;
  /** The newest message is a question still waiting for its answer. */
  readonly waiting: boolean;
}

const EMPTY_SIDE_THREADS: ReadonlyArray<SideThread> = Object.freeze([]);

/**
 * Groups a thread's side messages into side threads, ordered by when each
 * started. Messages keep their order within a thread.
 */
export function groupSideThreads(
  messages: ReadonlyArray<OrchestrationSideMessage> | undefined,
): ReadonlyArray<SideThread> {
  if (messages === undefined || messages.length === 0) return EMPTY_SIDE_THREADS;
  const byId = new Map<MessageId, OrchestrationSideMessage[]>();
  for (const message of messages) {
    const group = byId.get(message.sideThreadId);
    if (group === undefined) {
      byId.set(message.sideThreadId, [message]);
    } else {
      group.push(message);
    }
  }
  const threads: SideThread[] = [];
  for (const [id, group] of byId) {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    threads.push({
      id,
      // Follow-ups repeat the anchor, but the opening question owns it.
      anchorMessageId: first.anchorMessageId,
      messages: group,
      question: first.text,
      createdAt: first.createdAt,
      updatedAt: last.createdAt,
      replyCount: group.length - 1,
      waiting: last.role === "user",
    });
  }
  // `.sort()` on a fresh array: mobile runs on Hermes without ES2023 methods.
  return threads.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

/** Side threads keyed by the main-thread message they were started from. */
export function sideThreadsByAnchor(
  threads: ReadonlyArray<SideThread>,
): ReadonlyMap<MessageId, ReadonlyArray<SideThread>> {
  const byAnchor = new Map<MessageId, SideThread[]>();
  for (const thread of threads) {
    if (thread.anchorMessageId === null) continue;
    const group = byAnchor.get(thread.anchorMessageId);
    if (group === undefined) {
      byAnchor.set(thread.anchorMessageId, [thread]);
    } else {
      group.push(thread);
    }
  }
  return byAnchor;
}
