import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionSideThreadInput,
  DeleteProjectionThreadSideMessagesInput,
  ListProjectionThreadSideMessagesInput,
  ProjectionThreadSideMessage,
  ProjectionThreadSideMessageRepository,
  type ProjectionThreadSideMessageRepositoryShape,
} from "../Services/ProjectionThreadSideMessages.ts";

const makeProjectionThreadSideMessageRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionThreadSideMessage,
    execute: (row) => sql`
      INSERT INTO projection_thread_side_messages (
        message_id,
        thread_id,
        side_thread_id,
        role,
        text,
        anchor_message_id,
        created_at
      )
      VALUES (
        ${row.messageId},
        ${row.threadId},
        ${row.sideThreadId},
        ${row.role},
        ${row.text},
        ${row.anchorMessageId},
        ${row.createdAt}
      )
      ON CONFLICT (message_id)
      DO UPDATE SET
        thread_id = excluded.thread_id,
        side_thread_id = excluded.side_thread_id,
        role = excluded.role,
        text = excluded.text,
        anchor_message_id = excluded.anchor_message_id,
        created_at = excluded.created_at
    `,
  });

  const listRowsByThread = SqlSchema.findAll({
    Request: ListProjectionThreadSideMessagesInput,
    Result: ProjectionThreadSideMessage,
    execute: ({ threadId }) => sql`
      SELECT
        message_id AS "messageId",
        thread_id AS "threadId",
        side_thread_id AS "sideThreadId",
        role,
        text,
        anchor_message_id AS "anchorMessageId",
        created_at AS "createdAt"
      FROM projection_thread_side_messages
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, rowid ASC
    `,
  });

  // A question is unanswered while nothing was added to its side thread after
  // it. rowid follows insertion order, which breaks created_at ties.
  const listUnansweredRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSideMessage,
    execute: () => sql`
      SELECT
        messages.message_id AS "messageId",
        messages.thread_id AS "threadId",
        messages.side_thread_id AS "sideThreadId",
        messages.role,
        messages.text,
        messages.anchor_message_id AS "anchorMessageId",
        messages.created_at AS "createdAt"
      FROM projection_thread_side_messages AS messages
      INNER JOIN projection_threads AS threads
        ON threads.thread_id = messages.thread_id
      WHERE messages.role = 'user'
        AND threads.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM projection_thread_side_messages AS later
          WHERE later.thread_id = messages.thread_id
            AND later.side_thread_id = messages.side_thread_id
            AND (
              later.created_at > messages.created_at
              OR (later.created_at = messages.created_at AND later.rowid > messages.rowid)
            )
        )
      ORDER BY messages.created_at ASC, messages.rowid ASC
    `,
  });

  const deleteSideThreadRows = SqlSchema.void({
    Request: DeleteProjectionSideThreadInput,
    execute: ({ threadId, sideThreadId }) => sql`
      DELETE FROM projection_thread_side_messages
      WHERE thread_id = ${threadId} AND side_thread_id = ${sideThreadId}
    `,
  });

  const deleteThreadRows = SqlSchema.void({
    Request: DeleteProjectionThreadSideMessagesInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_side_messages
      WHERE thread_id = ${threadId}
    `,
  });

  const upsert: ProjectionThreadSideMessageRepositoryShape["upsert"] = (row) =>
    upsertRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadSideMessageRepository.upsert:query")),
    );

  const listByThreadId: ProjectionThreadSideMessageRepositoryShape["listByThreadId"] = (input) =>
    listRowsByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSideMessageRepository.listByThreadId:query"),
      ),
    );

  const listUnansweredQuestions: ProjectionThreadSideMessageRepositoryShape["listUnansweredQuestions"] =
    () =>
      listUnansweredRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionThreadSideMessageRepository.listUnansweredQuestions:query",
          ),
        ),
      );

  const deleteBySideThreadId: ProjectionThreadSideMessageRepositoryShape["deleteBySideThreadId"] = (
    input,
  ) =>
    deleteSideThreadRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSideMessageRepository.deleteBySideThreadId:query"),
      ),
    );

  const deleteByThreadId: ProjectionThreadSideMessageRepositoryShape["deleteByThreadId"] = (
    input,
  ) =>
    deleteThreadRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSideMessageRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    listByThreadId,
    listUnansweredQuestions,
    deleteBySideThreadId,
    deleteByThreadId,
  } satisfies ProjectionThreadSideMessageRepositoryShape;
});

export const ProjectionThreadSideMessageRepositoryLive = Layer.effect(
  ProjectionThreadSideMessageRepository,
  makeProjectionThreadSideMessageRepository,
);
