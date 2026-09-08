import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeReadModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("assistant complete decider", (it) => {
  it.effect("keeps streamed text when complete omits a replacement body", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.assistant.complete",
          commandId: CommandId.make("cmd-complete"),
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("assistant-1"),
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.message-sent");
      if (events[0]?.type === "thread.message-sent") {
        expect(events[0].payload.text).toBe("");
        expect(events[0].payload.streaming).toBe(false);
        expect(events[0].payload.attachments).toBeUndefined();
      }
    }),
  );

  it.effect("replaces the assistant body and stores attachments when complete provides them", () =>
    Effect.gen(function* () {
      const attachments = [
        {
          type: "image" as const,
          id: "thread-1-00000000-0000-4000-8000-000000000001",
          name: "1.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 12,
        },
      ];
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.assistant.complete",
          commandId: CommandId.make("cmd-complete-rewrite"),
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("assistant-1"),
          text: "See ![diagram](/tmp/attachments/1.jpg)",
          attachments,
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.message-sent");
      if (events[0]?.type === "thread.message-sent") {
        expect(events[0].payload.text).toBe("See ![diagram](/tmp/attachments/1.jpg)");
        expect(events[0].payload.attachments).toEqual(attachments);
        expect(events[0].payload.streaming).toBe(false);
      }
    }),
  );
});
