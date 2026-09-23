import { IsoDateTime, MessageId, OrchestrationSideMessageRole, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadSideMessage = Schema.Struct({
  messageId: MessageId,
  threadId: ThreadId,
  sideThreadId: MessageId,
  role: OrchestrationSideMessageRole,
  text: Schema.String,
  anchorMessageId: Schema.NullOr(MessageId),
  createdAt: IsoDateTime,
});
export type ProjectionThreadSideMessage = typeof ProjectionThreadSideMessage.Type;

export const ListProjectionThreadSideMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadSideMessagesInput =
  typeof ListProjectionThreadSideMessagesInput.Type;

export const DeleteProjectionSideThreadInput = Schema.Struct({
  threadId: ThreadId,
  sideThreadId: MessageId,
});
export type DeleteProjectionSideThreadInput = typeof DeleteProjectionSideThreadInput.Type;

export const DeleteProjectionThreadSideMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadSideMessagesInput =
  typeof DeleteProjectionThreadSideMessagesInput.Type;

export interface ProjectionThreadSideMessageRepositoryShape {
  readonly upsert: (
    message: ProjectionThreadSideMessage,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /** All side messages of one thread, oldest first. */
  readonly listByThreadId: (
    input: ListProjectionThreadSideMessagesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadSideMessage>, ProjectionRepositoryError>;
  /**
   * Questions still waiting for an answer across all live threads: the newest
   * message of their side thread is the question itself. Used to settle
   * questions orphaned by a server restart.
   */
  readonly listUnansweredQuestions: () => Effect.Effect<
    ReadonlyArray<ProjectionThreadSideMessage>,
    ProjectionRepositoryError
  >;
  readonly deleteBySideThreadId: (
    input: DeleteProjectionSideThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadSideMessagesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadSideMessageRepository extends Context.Service<
  ProjectionThreadSideMessageRepository,
  ProjectionThreadSideMessageRepositoryShape
>()("t3/persistence/Services/ProjectionThreadSideMessages/ProjectionThreadSideMessageRepository") {}
