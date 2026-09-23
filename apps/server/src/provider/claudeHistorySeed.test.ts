import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { buildClaudeSeedTranscript, claudeProjectDirName } from "./claudeHistorySeed.ts";

describe("claudeProjectDirName", () => {
  it("replaces every non-alphanumeric character like the CLI", () => {
    expect(claudeProjectDirName({ cwd: "/home/me/my_app.v2", environment: {} })).toBe(
      "-home-me-my-app-v2",
    );
  });

  it("gives up on names the CLI would hash", () => {
    expect(claudeProjectDirName({ cwd: `/${"a".repeat(200)}`, environment: {} })).toBeUndefined();
  });

  it("honors a valid project dir override only alongside a config dir", () => {
    const override = { CLAUDE_CODE_PROJECT_DIR_NAME: "work" };
    expect(claudeProjectDirName({ cwd: "/x", environment: override })).toBe("-x");
    expect(
      claudeProjectDirName({ cwd: "/x", environment: { ...override, CLAUDE_CONFIG_DIR: "/c" } }),
    ).toBe("work");
    expect(
      claudeProjectDirName({
        cwd: "/x",
        environment: { CLAUDE_CONFIG_DIR: "/c", CLAUDE_CODE_PROJECT_DIR_NAME: "nul" },
      }),
    ).toBe("-x");
  });
});

describe("buildClaudeSeedTranscript", () => {
  it("chains user and assistant turns into a resumable transcript", () => {
    const lines = buildClaudeSeedTranscript({
      sessionId: "session",
      cwd: "/repo",
      history: [
        { role: "user", text: "Fix the bug" },
        { role: "assistant", text: "Fixed" },
      ],
      startedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
      uuids: ["u1", "u2"],
    })
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(lines).toMatchObject([
      {
        parentUuid: null,
        type: "user",
        uuid: "u1",
        sessionId: "session",
        cwd: "/repo",
        message: { role: "user", content: [{ type: "text", text: "Fix the bug" }] },
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        parentUuid: "u1",
        type: "assistant",
        uuid: "u2",
        message: {
          role: "assistant",
          model: "<synthetic>",
          content: [{ type: "text", text: "Fixed" }],
        },
        timestamp: "2026-01-01T00:00:00.001Z",
      },
    ]);
  });
});
