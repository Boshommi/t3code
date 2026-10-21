import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadForkTargets } from "./threadForkTargets.ts";

const provider = (
  instanceId: string,
  models: ReadonlyArray<string>,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(instanceId),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: models.map((slug, index) => ({
    slug,
    name: slug,
    isCustom: false,
    ...(index === 0 ? { isDefault: true } : {}),
    capabilities: null,
  })),
  slashCommands: [],
  skills: [],
  ...overrides,
});

const projectId = ProjectId.make("project");
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const thread = {
  projectId,
  modelSelection: { instanceId: codex, model: "gpt-5-mini" },
};
const providers = [
  provider("codex", ["gpt-5", "gpt-5-mini"]),
  provider("claudeAgent", ["claude-opus", "claude-sonnet"]),
  provider("cursor", ["composer"], { enabled: false }),
  provider("opencode", ["big-pickle"], { status: "error" }),
  provider("grok", ["grok-4"], { availability: "unavailable" }),
];

describe("resolveThreadForkTargets", () => {
  it("offers every ready instance, keeping the thread's model on its own provider", () => {
    expect(
      resolveThreadForkTargets({ thread, providers, settings: null, recentModelSelections: [] }),
    ).toEqual([
      { label: "Codex", modelSelection: thread.modelSelection },
      { label: "Claude", modelSelection: { instanceId: claude, model: "claude-opus" } },
    ]);
  });

  it("starts on the user's last model for an instance while that model still exists", () => {
    const claudeModel = (model: string) =>
      resolveThreadForkTargets({
        thread,
        providers,
        settings: null,
        recentModelSelections: [{ instanceId: claude, model }],
      }).find((target) => target.modelSelection.instanceId === claude)?.modelSelection.model;
    expect(claudeModel("claude-sonnet")).toBe("claude-sonnet");
    expect(claudeModel("claude-retired")).toBe("claude-opus");
  });

  it("follows the project's provider enablement like the model picker", () => {
    const targets = resolveThreadForkTargets({
      thread,
      providers,
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [claude]: { enabled: false } } },
        },
      },
      recentModelSelections: [],
    });
    expect(targets.map((target) => target.modelSelection.instanceId)).toEqual([codex]);
  });
});
