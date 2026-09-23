import type { ProviderHistoryMessage } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

// Mirrors how the Claude CLI names a project's session directory. Longer names get a
// hashed suffix we do not reproduce, so those threads fall back to a text handoff.
const CLAUDE_PROJECT_DIR_NAME_MAX_LENGTH = 200;
const CLAUDE_PROJECT_DIR_NAME_OVERRIDE = /^[A-Za-z0-9_-]{1,64}$/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * The directory under `<config>/projects` where the Claude CLI keeps sessions for
 * `cwd`, or undefined when it cannot be derived without the CLI's path hash.
 */
export function claudeProjectDirName(input: {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}): string | undefined {
  const override = input.environment.CLAUDE_CODE_PROJECT_DIR_NAME;
  if (
    input.environment.CLAUDE_CONFIG_DIR &&
    override &&
    CLAUDE_PROJECT_DIR_NAME_OVERRIDE.test(override) &&
    !WINDOWS_RESERVED_NAME.test(override)
  ) {
    return override;
  }
  const name = input.cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return name.length <= CLAUDE_PROJECT_DIR_NAME_MAX_LENGTH ? name : undefined;
}

/**
 * A Claude session transcript holding `history` as plain text turns, which the CLI
 * resumes like any session it wrote itself. Assistant turns use the CLI's own
 * `<synthetic>` model marker so they are never mistaken for billed responses.
 */
export function buildClaudeSeedTranscript(input: {
  readonly sessionId: string;
  readonly cwd: string;
  readonly history: ReadonlyArray<ProviderHistoryMessage>;
  readonly startedAt: DateTime.Utc;
  /** One per history entry. */
  readonly uuids: ReadonlyArray<string>;
}): string {
  let parentUuid: string | null = null;
  const lines = input.history.map((entry, index) => {
    const uuid = input.uuids[index]!;
    const content = [{ type: "text", text: entry.text }];
    const line = {
      parentUuid,
      isSidechain: false,
      type: entry.role,
      message:
        entry.role === "user"
          ? { role: "user", content }
          : {
              id: `msg_handoff_${uuid}`,
              type: "message",
              role: "assistant",
              model: "<synthetic>",
              content,
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
      uuid,
      timestamp: DateTime.formatIso(DateTime.add(input.startedAt, { milliseconds: index })),
      userType: "external",
      cwd: input.cwd,
      sessionId: input.sessionId,
    };
    parentUuid = uuid;
    return JSON.stringify(line);
  });
  return `${lines.join("\n")}\n`;
}
