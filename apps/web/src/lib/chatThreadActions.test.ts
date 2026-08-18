import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  resolveThreadActionProjectRef,
  resolveNewDraftStartFromOrigin,
  resolveResurrectedEmptyDraftWorkspace,
  resolveDefaultThreadEnvModeSettingsPatch,
  resolveProjectThreadEnvModePatch,
  resolveStartFromOriginSettingsPatch,
  startNewThreadFromContext,
  type ChatThreadActionContext,
} from "./chatThreadActions";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const FALLBACK_PROJECT_ID = ProjectId.make("project-2");

function createContext(overrides: Partial<ChatThreadActionContext> = {}): ChatThreadActionContext {
  return {
    activeDraftThread: null,
    activeThread: undefined,
    defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID),
    handleNewThread: async () => {},
    ...overrides,
  };
}

describe("chatThreadActions", () => {
  it("only applies the start-from-origin default to new worktree drafts", () => {
    expect(
      resolveNewDraftStartFromOrigin({
        envMode: "worktree",
        newWorktreesStartFromOrigin: true,
      }),
    ).toBe(true);
    expect(
      resolveNewDraftStartFromOrigin({
        envMode: "local",
        newWorktreesStartFromOrigin: true,
      }),
    ).toBe(false);
  });

  it("resets an empty stored draft to configured defaults on a new-thread request", () => {
    expect(
      resolveResurrectedEmptyDraftWorkspace({
        explicitWorkspace: null,
        isDraftAlreadyOpen: false,
        preserveEmptyDraftWorkspace: false,
        defaultEnvMode: "worktree",
        newWorktreesStartFromOrigin: true,
      }),
    ).toEqual({
      branch: null,
      worktreePath: null,
      envMode: "worktree",
      startFromOrigin: true,
    });
  });

  it("keeps the stored workspace when the empty draft is already open", () => {
    expect(
      resolveResurrectedEmptyDraftWorkspace({
        explicitWorkspace: null,
        isDraftAlreadyOpen: true,
        preserveEmptyDraftWorkspace: false,
        defaultEnvMode: "worktree",
        newWorktreesStartFromOrigin: true,
      }),
    ).toBeNull();
  });

  it("keeps the stored workspace when landing after an app reload", () => {
    expect(
      resolveResurrectedEmptyDraftWorkspace({
        explicitWorkspace: null,
        isDraftAlreadyOpen: false,
        preserveEmptyDraftWorkspace: true,
        defaultEnvMode: "local",
        newWorktreesStartFromOrigin: false,
      }),
    ).toBeNull();
  });

  it("still applies explicit workspace options while preserving a stored draft", () => {
    expect(
      resolveResurrectedEmptyDraftWorkspace({
        explicitWorkspace: { branch: "main", startFromOrigin: false },
        isDraftAlreadyOpen: false,
        preserveEmptyDraftWorkspace: true,
        defaultEnvMode: "worktree",
        newWorktreesStartFromOrigin: true,
      }),
    ).toEqual({ branch: "main", startFromOrigin: false });
  });

  it("writes the workspace-mode picker back to the stored default", () => {
    expect(
      resolveDefaultThreadEnvModeSettingsPatch({
        nextEnvMode: "worktree",
        currentDefault: "local",
      }),
    ).toEqual({ defaultThreadEnvMode: "worktree" });
    expect(
      resolveDefaultThreadEnvModeSettingsPatch({
        nextEnvMode: "local",
        currentDefault: "local",
      }),
    ).toBeNull();
  });

  it("pins the workspace-mode picker onto the project so t3.json cannot win", () => {
    expect(
      resolveProjectThreadEnvModePatch({
        nextEnvMode: "worktree",
        currentProjectDefault: null,
      }),
    ).toEqual({ defaultThreadEnvMode: "worktree" });
    expect(
      resolveProjectThreadEnvModePatch({
        nextEnvMode: "local",
        currentProjectDefault: "local",
      }),
    ).toBeNull();
  });

  it("writes the start-from-origin toggle back to the stored default", () => {
    expect(
      resolveStartFromOriginSettingsPatch({
        nextStartFromOrigin: false,
        currentDefault: true,
      }),
    ).toEqual({ newWorktreesStartFromOrigin: false });
    expect(
      resolveStartFromOriginSettingsPatch({
        nextStartFromOrigin: true,
        currentDefault: true,
      }),
    ).toBeNull();
  });

  it("prefers the active thread project when resolving thread actions", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        activeThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
        },
      }),
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("falls back to the active draft thread project when there is no active thread", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        activeDraftThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
        },
      }),
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("falls back to the default project ref when there is no active thread context", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
      }),
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("inherits only the project from context, never branch or worktree state", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    const didStart = await startNewThreadFromContext(
      createContext({
        activeThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
        },
        handleNewThread,
      }),
    );

    expect(didStart).toBe(true);
    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("does not start a thread when there is no project context", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    const didStart = await startNewThreadFromContext(
      createContext({
        defaultProjectRef: null,
        handleNewThread,
      }),
    );

    expect(didStart).toBe(false);
    expect(handleNewThread).not.toHaveBeenCalled();
  });
});
