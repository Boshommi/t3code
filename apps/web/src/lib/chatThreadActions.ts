import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ScopedProjectRef,
} from "@t3tools/contracts";
import type { ComposerThreadDraftState, DraftThreadEnvMode } from "../composerDraftStore";

type ComposerModelSelectionState = Pick<
  ComposerThreadDraftState,
  "activeProvider" | "modelSelectionByProvider" | "modelSelectionExplicit"
>;

interface ThreadContextLike {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}

interface NewThreadHandler {
  (
    projectRef: ScopedProjectRef,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
    },
    // The opened draft's identity, which most callers have no use for.
  ): Promise<unknown>;
}

export interface ChatThreadActionContext {
  readonly activeDraftThread: ThreadContextLike | null;
  readonly activeThread: ThreadContextLike | undefined;
  readonly defaultProjectRef: ScopedProjectRef | null;
  readonly handleNewThread: NewThreadHandler;
}

export function resolveNewDraftStartFromOrigin(input: {
  envMode: DraftThreadEnvMode;
  newWorktreesStartFromOrigin: boolean;
}): boolean {
  return input.envMode === "worktree" && input.newWorktreesStartFromOrigin;
}

export function resolveNewThreadModelSelectionOverride(input: {
  readonly projectDefaultSelection: ModelSelection | null;
  readonly carrySelection: ModelSelection | null;
  readonly carrySourceDraftId: string | null;
  readonly destinationDraftId: string;
}): ModelSelection | null {
  return (
    input.projectDefaultSelection ??
    (input.carrySourceDraftId === input.destinationDraftId ? null : input.carrySelection)
  );
}

export function hasExplicitComposerModelSelection(
  draft: ComposerModelSelectionState | null | undefined,
): boolean {
  const activeProvider = draft?.activeProvider;
  return (
    draft?.modelSelectionExplicit === true &&
    activeProvider !== null &&
    activeProvider !== undefined &&
    draft.modelSelectionByProvider[activeProvider] !== undefined
  );
}

export interface DraftWorkspaceContext {
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
  startFromOrigin?: boolean;
}

// Reusing an empty stored draft is not the same as opening the draft the
// user is already looking at. Explicit new-thread surfaces reset workspace
// context to configured defaults so old carry-over checkouts do not stick
// forever. App-reload landing reopens the same in-progress draft and must
// keep the branch / start-from-origin the user just picked.
export function resolveResurrectedEmptyDraftWorkspace(input: {
  explicitWorkspace: DraftWorkspaceContext | null;
  isDraftAlreadyOpen: boolean;
  preserveEmptyDraftWorkspace: boolean;
  defaultEnvMode: DraftThreadEnvMode;
  newWorktreesStartFromOrigin: boolean;
}): DraftWorkspaceContext | null {
  if (input.explicitWorkspace !== null) {
    return input.explicitWorkspace;
  }
  if (input.isDraftAlreadyOpen || input.preserveEmptyDraftWorkspace) {
    return null;
  }
  return {
    branch: null,
    worktreePath: null,
    envMode: input.defaultEnvMode,
    startFromOrigin: resolveNewDraftStartFromOrigin({
      envMode: input.defaultEnvMode,
      newWorktreesStartFromOrigin: input.newWorktreesStartFromOrigin,
    }),
  };
}

export function resolveStartFromOriginSettingsPatch(input: {
  nextStartFromOrigin: boolean;
  currentDefault: boolean;
}): { newWorktreesStartFromOrigin: boolean } | null {
  if (input.nextStartFromOrigin === input.currentDefault) {
    return null;
  }
  return { newWorktreesStartFromOrigin: input.nextStartFromOrigin };
}

export function resolveDefaultThreadEnvModeSettingsPatch(input: {
  nextEnvMode: DraftThreadEnvMode;
  currentDefault: DraftThreadEnvMode;
}): { defaultThreadEnvMode: DraftThreadEnvMode } | null {
  if (input.nextEnvMode === input.currentDefault) {
    return null;
  }
  return { defaultThreadEnvMode: input.nextEnvMode };
}

// New drafts resolve project setting before t3.json and the global default.
// The workspace picker has to write that layer or a project override / checked-in
// t3.json keeps winning after reload.
export function resolveProjectThreadEnvModePatch(input: {
  nextEnvMode: DraftThreadEnvMode;
  currentProjectDefault: DraftThreadEnvMode | null | undefined;
}): { defaultThreadEnvMode: DraftThreadEnvMode } | null {
  if (input.currentProjectDefault === input.nextEnvMode) {
    return null;
  }
  return { defaultThreadEnvMode: input.nextEnvMode };
}

export function resolveThreadActionProjectRef(
  context: ChatThreadActionContext,
): ScopedProjectRef | null {
  if (context.activeThread) {
    return scopeProjectRef(context.activeThread.environmentId, context.activeThread.projectId);
  }
  if (context.activeDraftThread) {
    return scopeProjectRef(
      context.activeDraftThread.environmentId,
      context.activeDraftThread.projectId,
    );
  }
  return context.defaultProjectRef;
}

// New threads inherit only the *project* from the current context. Branch,
// worktree, and env mode always come from the user's configured defaults —
// carrying them over from the viewed thread meant "new thread" silently
// reused checkouts and branches. Explicit affordances (branch toolbar's
// "new thread in this worktree") pass those options to handleNewThread
// directly instead.
export async function startNewThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) {
    return false;
  }

  await context.handleNewThread(projectRef);
  return true;
}
