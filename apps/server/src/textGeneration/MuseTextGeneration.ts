/**
 * MuseTextGeneration — commit messages, PR text, branch names, and thread
 * titles through a throwaway Muse Code host.
 *
 * Each call spawns a throwaway host whose data directory is owned by T3 Code,
 * so these one-shot sessions never appear in the user's `muse resume` picker.
 * Muse's memory-only mode (`--no-session-log`) accepts turns without running
 * them, so a durable session in a private store is the only working option.
 * The session starts with `denyUnmatched` so the model cannot run tools while
 * answering a formatting prompt, and the call returns as soon as the answer
 * item completes: Muse keeps the turn open for background housekeeping agents
 * long after the reply is final.
 *
 * @module textGeneration/MuseTextGeneration
 */
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { TextGenerationError, type ModelSelection, type MuseSettings } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import { makeUuidV7, withMspHost } from "../provider/msp/MspConnection.ts";
import {
  MSP_REASONING_EFFORTS,
  MspItemLifecycleParams,
  MspSessionStartResult,
  MspTurnCompletedParams,
  MspTurnStartResult,
} from "../provider/msp/MspProtocol.ts";

const MUSE_TIMEOUT_MS = 180_000;
const DEFAULT_TEXT_REASONING_EFFORT = "low";

const isTextGenerationError = Schema.is(TextGenerationError);
const decodeItem = Schema.decodeUnknownOption(MspItemLifecycleParams);
const decodeTurnCompleted = Schema.decodeUnknownOption(MspTurnCompletedParams);

type Operation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

export const makeMuseTextGeneration = Effect.fn("makeMuseTextGeneration")(function* (
  museSettings: MuseSettings,
  environment: NodeJS.ProcessEnv = process.env,
  options?: {
    readonly clientVersion?: string;
    /** `XDG_DATA_HOME` for the throwaway host. Omit to share the user's store. */
    readonly dataHome?: string;
  },
) {
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const clientVersion = options?.clientVersion ?? "0.0.0";
  const hostEnvironment: NodeJS.ProcessEnv = options?.dataHome
    ? { ...environment, XDG_DATA_HOME: options.dataHome }
    : environment;

  const runMuseJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation: Operation;
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const outputRef = yield* Ref.make("");
      const completed = yield* Deferred.make<{ readonly failure: string | undefined }>();
      const requestedEffort = getModelSelectionStringOptionValue(modelSelection, "reasoningEffort");
      const reasoningEffort = (MSP_REASONING_EFFORTS as ReadonlyArray<string>).includes(
        requestedEffort ?? "",
      )
        ? requestedEffort
        : DEFAULT_TEXT_REASONING_EFFORT;

      const run = withMspHost(
        {
          command: museSettings.binaryPath || "muse",
          args: ["serve"],
          cwd,
          env: hostEnvironment,
          clientVersion,
          onNotification: (notification) =>
            Effect.gen(function* () {
              if (notification.method === "item/completed") {
                const item = decodeItem(notification.params);
                if (Option.isSome(item) && item.value.item.kind === "agentMessage") {
                  yield* Ref.update(outputRef, (current) => current + (item.value.item.text ?? ""));
                  yield* Deferred.succeed(completed, { failure: undefined });
                }
                return;
              }
              if (notification.method === "turn/completed") {
                const turn = decodeTurnCompleted(notification.params);
                if (Option.isNone(turn)) return;
                const failure =
                  turn.value.terminal === "completed"
                    ? undefined
                    : (turn.value.error?.message ?? turn.value.reason ?? turn.value.terminal);
                yield* Deferred.succeed(completed, { failure });
              }
            }),
        },
        (connection) =>
          Effect.gen(function* () {
            const started = yield* connection.request(
              "session/start",
              {
                commandId: yield* makeUuidV7(),
                workspaceRoot: cwd,
                approvalMode: "denyUnmatched",
                modelId: modelSelection.model,
              },
              MspSessionStartResult,
            );
            yield* connection.request(
              "turn/start",
              {
                commandId: yield* makeUuidV7(),
                sessionId: started.session.sessionId,
                input: [{ type: "text", text: prompt }],
                reasoningEffort,
              },
              MspTurnStartResult,
            );
            return yield* Deferred.await(completed);
          }),
      ).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const outcome = yield* run.pipe(
        Effect.timeoutOption(MUSE_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Muse Code request timed out." }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({ operation, detail: "Muse Code request failed.", cause }),
        ),
      );
      if (outcome.failure !== undefined) {
        return yield* new TextGenerationError({
          operation,
          detail: `Muse Code turn failed: ${outcome.failure}`,
        });
      }

      const trimmed = (yield* Ref.get(outputRef)).trim();
      if (!trimmed) {
        return yield* new TextGenerationError({
          operation,
          detail: "Muse Code returned empty output.",
        });
      }
      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(trimmed)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Muse Code returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("MuseTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runMuseJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("MuseTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runMuseJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("MuseTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runMuseJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("MuseTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const generated = yield* runMuseJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        title: sanitizeThreadTitle(generated.title),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
