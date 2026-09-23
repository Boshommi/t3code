import { describe, expect, it } from "vite-plus/test";

import { MessageId, type OrchestrationSideMessage } from "@t3tools/contracts";

import { groupSideThreads, sideThreadsByAnchor } from "./sideThreads.ts";

const message = (
  id: string,
  sideThreadId: string,
  role: OrchestrationSideMessage["role"],
  createdAt: string,
  anchorMessageId: string | null = null,
): OrchestrationSideMessage => ({
  id: MessageId.make(id),
  sideThreadId: MessageId.make(sideThreadId),
  role,
  text: `${role} ${id}`,
  anchorMessageId: anchorMessageId === null ? null : MessageId.make(anchorMessageId),
  createdAt,
});

describe("groupSideThreads", () => {
  it("groups by side thread in start order and derives reply state", () => {
    const threads = groupSideThreads([
      message("q-2", "q-2", "user", "2026-04-01T00:00:02.000Z", "m-1"),
      message("q-1", "q-1", "user", "2026-04-01T00:00:01.000Z"),
      message("a-1", "q-1", "assistant", "2026-04-01T00:00:03.000Z"),
      message("e-2", "q-2", "error", "2026-04-01T00:00:04.000Z", "m-1"),
      message("q-1b", "q-1", "user", "2026-04-01T00:00:05.000Z"),
    ]);

    expect(threads.map((thread) => thread.id)).toEqual(["q-1", "q-2"]);
    expect(threads[0]).toMatchObject({
      question: "user q-1",
      replyCount: 2,
      waiting: true,
      updatedAt: "2026-04-01T00:00:05.000Z",
    });
    // A failed answer is not waiting: the user may ask again.
    expect(threads[1]).toMatchObject({ anchorMessageId: "m-1", replyCount: 1, waiting: false });
  });

  it("returns an empty list for a thread without side messages", () => {
    expect(groupSideThreads(undefined)).toEqual([]);
  });
});

describe("sideThreadsByAnchor", () => {
  it("indexes anchored side threads and skips unanchored ones", () => {
    const byAnchor = sideThreadsByAnchor(
      groupSideThreads([
        message("q-1", "q-1", "user", "2026-04-01T00:00:01.000Z", "m-1"),
        message("q-2", "q-2", "user", "2026-04-01T00:00:02.000Z", "m-1"),
        message("q-3", "q-3", "user", "2026-04-01T00:00:03.000Z"),
      ]),
    );

    expect([...byAnchor.keys()]).toEqual(["m-1"]);
    expect(byAnchor.get(MessageId.make("m-1"))?.map((thread) => thread.id)).toEqual(["q-1", "q-2"]);
  });
});
