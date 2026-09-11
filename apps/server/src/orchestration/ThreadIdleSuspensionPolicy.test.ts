import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isIdleSuspensionCandidate } from "./ThreadIdleSuspensionPolicy.ts";

const NOW = "2026-09-11T20:00:00.000Z";
const SIX_MINUTES_AGO = "2026-09-11T19:54:00.000Z";
const FOUR_MINUTES_AGO = "2026-09-11T19:56:00.000Z";

const makeThread = (
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature",
  worktreePath: "/repo",
  latestTurn: null,
  createdAt: SIX_MINUTES_AGO,
  updatedAt: SIX_MINUTES_AGO,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: SIX_MINUTES_AGO,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

describe("isIdleSuspensionCandidate", () => {
  it("suspends a thread idle for more than five minutes", () => {
    expect(isIdleSuspensionCandidate(makeThread(), NOW)).toBe(true);
  });

  it("keeps a recently active thread", () => {
    expect(isIdleSuspensionCandidate(makeThread({ updatedAt: FOUR_MINUTES_AGO }), NOW)).toBe(false);
  });

  it("keeps a thread with a running session", () => {
    expect(
      isIdleSuspensionCandidate(
        makeThread({
          session: {
            threadId: ThreadId.make("thread-1"),
            providerName: "codex",
            runtimeMode: "full-access",
            status: "running",
            activeTurnId: TurnId.make("turn-1"),
            lastError: null,
            updatedAt: SIX_MINUTES_AGO,
          },
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it("keeps a thread with a queued turn start", () => {
    expect(
      isIdleSuspensionCandidate(
        makeThread({ latestUserMessageAt: "2026-09-11T19:59:30.000Z" }),
        NOW,
      ),
    ).toBe(false);
  });

  it("keeps a thread with background work", () => {
    expect(isIdleSuspensionCandidate(makeThread({ backgroundLiveness: "working" }), NOW)).toBe(
      false,
    );
  });

  it("skips archived threads", () => {
    expect(isIdleSuspensionCandidate(makeThread({ archivedAt: SIX_MINUTES_AGO }), NOW)).toBe(false);
  });
});
