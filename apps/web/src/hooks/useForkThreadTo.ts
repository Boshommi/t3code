import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  resolveThreadForkTargets,
  type ThreadForkTarget,
} from "@t3tools/client-runtime/state/thread-fork-targets";
import type { ModelSelection, ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useComposerDraftStore } from "../composerDraftStore";
import { newThreadId } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell, waitForThreadShell } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { buildThreadRouteParams } from "../threadRoutes";

/** "Fork to" targets for a thread's menu, read when it opens. Empty hides the item. */
export function readThreadForkTargets(threadRef: ScopedThreadRef): ReadonlyArray<ThreadForkTarget> {
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(threadRef.environmentId);
  const thread = readThreadShell(threadRef);
  // A thread without a run has nothing to carry over; starting a new thread is the same.
  if (config?.environment.capabilities.threadForkToProvider !== true || !thread?.latestRun) {
    return [];
  }
  return resolveThreadForkTargets({
    thread,
    providers: config.providers,
    settings: config.settings,
    recentModelSelections: Object.values(
      useComposerDraftStore.getState().stickyModelSelectionByProvider,
    ).filter((selection) => selection !== undefined),
  });
}

/** Forks a thread's conversation onto another provider or model, then opens the fork. */
export function useForkThreadTo() {
  const router = useRouter();
  const forkThreadTo = useOrchestrationCommand(threadEnvironment.forkTo, { reportFailure: false });

  return async (source: ScopedThreadRef, modelSelection: ModelSelection) => {
    const forkRef = scopeThreadRef(source.environmentId, newThreadId());
    const result = await forkThreadTo({
      environmentId: source.environmentId,
      input: {
        sourceThreadId: source.threadId,
        targetThreadId: forkRef.threadId,
        modelSelection,
      },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not fork thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
      return;
    }
    if (!(await waitForThreadShell(forkRef))) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Fork created",
          description:
            "Its thread data did not reach this client. Reconnect and open it from the sidebar.",
        }),
      );
      return;
    }
    await router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(forkRef),
    });
  };
}
