/**
 * Runs the `!command`s the Orchestrator records as running shell command items
 * (see ShellCommands.ts) and completes each item with its output.
 *
 * The command runs once in the thread's working directory using the user's
 * login shell. Each runs in its own fiber, never through the effect outbox,
 * which serializes a thread's effects: a two-minute command must not hold up
 * the thread's turn, steering, or Stop. The fiber is detached from the client
 * request, so a disconnect cannot leave the row running. A row a server stop
 * cut off is cancelled by startup runtime recovery, like any unfinished
 * command item.
 */
import { EventId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProcessRunner, type ProcessRunOutput } from "../processRunner.ts";
import { forkParked } from "../serverActivation.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { isShellCommandTurnItem, type ShellCommandTurnItem } from "./ShellCommands.ts";

const COMMAND_TIMEOUT_SECONDS = 120;
const OUTPUT_MAX_BYTES = 64 * 1024;
const TRUNCATED_MARKER = "\n[output truncated]";

type CommandResult = Pick<
  ShellCommandTurnItem,
  "status" | "output" | "exitCode" | "outputIndicatesFailure"
>;

export class ShellCommandReactor extends Context.Service<
  ShellCommandReactor,
  {
    /** Runs every shell command recorded from now on. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Resolves once no command is running. For tests. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ShellCommandReactor") {}

/** The user's shell as a login shell, so `PATH` matches what their terminal sees. */
const shellInvocation = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const env = yield* HostProcess.Environment;
  return platform === "win32"
    ? { command: env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c"] }
    : { command: env.SHELL || "/bin/sh", args: ["-lc"] };
});

function settle(output: ProcessRunOutput): CommandResult {
  const text = [output.stdout, output.stderr]
    .map((part) => part.trimEnd())
    .filter((part) => part.length > 0)
    .join("\n");
  if (output.timedOut) {
    return {
      status: "failed",
      output: `${text}\n[timed out after ${COMMAND_TIMEOUT_SECONDS}s]`.trim(),
      outputIndicatesFailure: true,
    };
  }
  if (output.code === null) {
    return { status: "failed", output: text, outputIndicatesFailure: true };
  }
  const exitCode = Number(output.code);
  return { status: exitCode === 0 ? "completed" : "failed", output: text, exitCode };
}

const RUN_FAILED: CommandResult = {
  status: "failed",
  output: "Couldn't run the command in this thread's directory.",
  outputIndicatesFailure: true,
};

export const make = Effect.gen(function* () {
  const eventSink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const runner = yield* ProcessRunner;
  const crypto = yield* Crypto.Crypto;
  const running = yield* FiberSet.make<void>();
  // A command runs once even if its running item is delivered twice.
  const claimed = new Set<ShellCommandTurnItem["id"]>();

  /** The thread's worktree, else its project root. Null when the thread is gone. */
  const workingDirectory = Effect.fn("ShellCommandReactor.workingDirectory")(function* (
    item: ShellCommandTurnItem,
  ) {
    const thread = yield* projections.getThread(item.threadId);
    if (thread.deletedAt !== null) return null;
    if (thread.worktreePath !== null) return thread.worktreePath;
    const project = yield* projects.get(thread.projectId);
    return Option.isSome(project) ? project.value.workspaceRoot : null;
  });

  const execute = Effect.fn("ShellCommandReactor.execute")(
    function* (item: ShellCommandTurnItem) {
      const cwd = yield* workingDirectory(item);
      const shell = yield* shellInvocation;
      const result =
        cwd === null
          ? RUN_FAILED
          : yield* runner
              .run({
                command: shell.command,
                args: [...shell.args, item.input],
                cwd,
                timeout: `${COMMAND_TIMEOUT_SECONDS} seconds`,
                timeoutBehavior: "timedOutResult",
                maxOutputBytes: OUTPUT_MAX_BYTES,
                outputMode: "truncate",
                truncatedMarker: TRUNCATED_MARKER,
              })
              .pipe(
                Effect.map(settle),
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : Effect.logWarning("shell command failed to run", {
                        threadId: item.threadId,
                        cause: Cause.pretty(cause),
                      }).pipe(Effect.as(RUN_FAILED)),
                ),
              );
      // A thread deleted meanwhile keeps no new rows.
      if ((yield* projections.getThread(item.threadId)).deletedAt !== null) return;
      const completedAt = yield* DateTime.now;
      const uuid = yield* crypto.randomUUIDv4();
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`event:shell-command:${uuid}`),
            type: "turn-item.updated",
            threadId: item.threadId,
            occurredAt: completedAt,
            payload: { ...item, ...result, completedAt, updatedAt: completedAt },
          },
        ],
      });
    },
    (effect, item) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("shell command result could not be recorded", {
                threadId: item.threadId,
                cause: Cause.pretty(cause),
              }),
        ),
        Effect.ensuring(Effect.sync(() => claimed.delete(item.id))),
      ),
  );

  const start: ShellCommandReactor["Service"]["start"] = Effect.fn("ShellCommandReactor.start")(
    function* () {
      // Items left running by an earlier process are runtime recovery's to
      // cancel, so only commands recorded after this cursor run.
      const cursor = yield* eventSink.latestSequence();
      yield* forkParked(
        eventSink.stream({ afterSequence: cursor, eventType: "turn-item.updated" }).pipe(
          Stream.runForEach(({ event }) => {
            if (
              event.type !== "turn-item.updated" ||
              !isShellCommandTurnItem(event.payload) ||
              event.payload.status !== "running" ||
              claimed.has(event.payload.id)
            ) {
              return Effect.void;
            }
            claimed.add(event.payload.id);
            return FiberSet.run(running, execute(event.payload)).pipe(Effect.asVoid);
          }),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("shell command stream failed", { cause: Cause.pretty(cause) }),
          ),
        ),
      );
    },
    Effect.catch((cause) => Effect.logWarning("shell command reactor could not start", { cause })),
  );

  return ShellCommandReactor.of({ start, drain: FiberSet.awaitEmpty(running) });
});

export const layer = Layer.effect(ShellCommandReactor, make);
