import {
  type ModelSelection,
  type ProjectId,
  resolveProjectProviderInstanceEnabled,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";

import { resolveProviderInstanceDisplayName } from "./providerInstanceDisplay.ts";

export interface ThreadForkTarget {
  readonly label: string;
  readonly modelSelection: ModelSelection;
}

/** Menu action id for a target; one target per instance, so the instance id is enough. */
export function threadForkTargetMenuId(target: ThreadForkTarget): `fork:${string}` {
  return `fork:${target.modelSelection.instanceId}`;
}

/**
 * Provider instances a thread's conversation can be forked onto: every instance
 * the model picker could start a new thread on, since a fork has no provider
 * session for the server's switch policy to restrict. Each target starts on the
 * thread's model when it is the thread's own instance, else the user's last
 * model for that instance, else the instance default.
 */
export function resolveThreadForkTargets(input: {
  readonly thread: { readonly projectId: ProjectId; readonly modelSelection: ModelSelection };
  readonly providers: ReadonlyArray<ServerProvider>;
  /** Folds in project enablement overrides, as the picker does; null uses the snapshot. */
  readonly settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides"> | null;
  readonly recentModelSelections: ReadonlyArray<ModelSelection>;
}): ReadonlyArray<ThreadForkTarget> {
  return input.providers.flatMap((provider) => {
    const enabled = input.settings
      ? resolveProjectProviderInstanceEnabled(
          input.settings,
          input.thread.projectId,
          provider.instanceId,
        )
      : provider.enabled;
    if (!enabled || provider.availability === "unavailable" || provider.status !== "ready") {
      return [];
    }
    const hasModel = (model: string) => provider.models.some((entry) => entry.slug === model);
    const preferred = [input.thread.modelSelection, ...input.recentModelSelections].find(
      (selection) => selection.instanceId === provider.instanceId && hasModel(selection.model),
    );
    const model =
      preferred?.model ??
      provider.models.find((entry) => entry.isDefault && !entry.isCustom)?.slug ??
      provider.models.find((entry) => !entry.isCustom)?.slug ??
      provider.models[0]?.slug;
    if (model === undefined) return [];
    return [
      {
        label: resolveProviderInstanceDisplayName(provider),
        // Keep the thread's or user's options (effort, etc.) only with the model they were set for.
        modelSelection: preferred ?? { instanceId: provider.instanceId, model },
      },
    ];
  });
}
