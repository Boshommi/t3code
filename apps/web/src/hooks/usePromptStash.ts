import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type PromptStashEntry,
  type PromptStashSummary,
  summarizePromptStashEntry,
} from "@t3tools/contracts";
import { useEffect } from "react";

import {
  localPromptStashEntriesForEnvironment,
  migrateLocalPromptStash,
  usePromptStashStore,
} from "../promptStashStore";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

const EMPTY_SUMMARIES: ReadonlyArray<PromptStashSummary> = [];

function newestFirst(left: PromptStashSummary, right: PromptStashSummary): number {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

/**
 * Saved prompts for one environment. Servers that store them share the list
 * across their clients; older servers fall back to this browser's storage.
 * Browser entries from before the server stored them migrate on first use and
 * stay listed until the server confirms each one.
 */
export function usePromptStash(environmentId: EnvironmentId) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const supported = config?.environment.capabilities.promptStash === true;
  const localEntries = usePromptStashStore((state) => state.entries);
  const serverList = useEnvironmentQuery(
    supported ? serverEnvironment.promptStash({ environmentId, input: {} }) : null,
  );
  const save = useAtomCommand(serverEnvironment.savePromptStashEntry, { reportFailure: false });
  const remove = useAtomCommand(serverEnvironment.deletePromptStashEntry, {
    reportFailure: false,
  });
  const get = useAtomCommand(serverEnvironment.getPromptStashEntry, { reportFailure: false });

  const savedOnServer = serverList.data ?? EMPTY_SUMMARIES;
  const pendingLocalEntries = supported
    ? localPromptStashEntriesForEnvironment(localEntries, environmentId).filter(
        (entry) => !savedOnServer.some((saved) => saved.id === entry.id),
      )
    : localEntries;
  const entries = supported
    ? [...savedOnServer, ...pendingLocalEntries.map(summarizePromptStashEntry)].sort(newestFirst)
    : localEntries.map(summarizePromptStashEntry);

  // Zero until the server list loads. Each list update retries imports that failed.
  const serverListUpdatedAt = serverList.dataUpdatedAt;
  const hasLocalEntries = localEntries.length > 0;
  useEffect(() => {
    if (!supported || serverListUpdatedAt === 0 || !hasLocalEntries) return;
    void migrateLocalPromptStash(
      environmentId,
      async (entry) => (await save({ environmentId, input: { entry } }))._tag === "Success",
    );
  }, [environmentId, supported, serverListUpdatedAt, hasLocalEntries, save]);

  const saveEntry = async (entry: PromptStashEntry) => {
    if (!supported) return usePromptStashStore.getState().stashEntry(entry);
    const saved = (await save({ environmentId, input: { entry } }))._tag === "Success";
    return { evicted: null, written: saved, durable: saved };
  };

  const getEntry = async (id: string): Promise<PromptStashEntry | null> => {
    const local = pendingLocalEntries.find((entry) => entry.id === id);
    if (local) return local;
    const fetched = await get({ environmentId, input: { id } });
    return fetched._tag === "Success" ? fetched.value : null;
  };

  /**
   * Deletes an entry. `files` are the uploads it referenced, for the caller to
   * release once `durable` says the delete will stick.
   */
  const deleteEntry = async (id: string) => {
    const files = entries.find((entry) => entry.id === id)?.files ?? [];
    if (!supported) {
      return { files, durable: usePromptStashStore.getState().takeEntry(id).durable };
    }
    // Delete on the server even for an entry still migrating: its tombstone stops a
    // retried import from bringing the prompt back.
    const removed = (await remove({ environmentId, input: { id } }))._tag === "Success";
    if (removed) usePromptStashStore.getState().takeEntry(id);
    return { files, durable: removed };
  };

  /**
   * Copies every saved prompt to another environment. Uploaded files belong to
   * the environment holding their bytes, so prompts with files stay here. Entry
   * ids make a repeated copy a no-op.
   */
  const copyEntries = async (targetEnvironmentId: EnvironmentId) => {
    let copied = 0;
    let skipped = 0;
    let failed = 0;
    for (const summary of entries) {
      if ((summary.files?.length ?? 0) > 0) {
        skipped += 1;
        continue;
      }
      const entry = await getEntry(summary.id);
      const result = entry
        ? await save({ environmentId: targetEnvironmentId, input: { entry } })
        : null;
      if (result?._tag === "Success") copied += 1;
      else failed += 1;
    }
    return { copied, skipped, failed };
  };

  return { entries, saveEntry, getEntry, deleteEntry, copyEntries };
}
