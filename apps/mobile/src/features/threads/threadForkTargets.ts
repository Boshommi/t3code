import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  resolveThreadForkTargets,
  type ThreadForkTarget,
} from "@t3tools/client-runtime/state/thread-fork-targets";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { stickyComposerModelSelectionAtom } from "../../state/use-composer-drafts";

/**
 * "Fork to" targets for a thread row's menu. Read rather than subscribed so
 * rows don't re-render on provider status pushes; empty hides the item.
 */
export function readThreadForkTargets(
  thread: EnvironmentThreadShell,
): ReadonlyArray<ThreadForkTarget> {
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(thread.environmentId);
  // A thread without a run has nothing to carry over; starting a new thread is the same.
  if (config?.environment.capabilities.threadForkToProvider !== true || !thread.latestRun) {
    return [];
  }
  const sticky = appAtomRegistry.get(stickyComposerModelSelectionAtom);
  return resolveThreadForkTargets({
    thread,
    providers: config.providers,
    settings: config.settings,
    recentModelSelections: sticky ? [sticky] : [],
  });
}
