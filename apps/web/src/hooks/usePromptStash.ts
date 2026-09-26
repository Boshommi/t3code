import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type PromptStashEntry,
  type PromptStashSummary,
  summarizePromptStashEntry,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo } from "react";
import {
  usePromptStashStore,
  migrateLocalPromptStash,
  localPromptStashEntriesForEnvironment,
} from "../promptStashStore";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

const EMPTY_ENTRIES: ReadonlyArray<PromptStashSummary> = [];
const emptyEntriesAtom = Atom.make(AsyncResult.success(EMPTY_ENTRIES));

export function usePromptStash(environmentId: EnvironmentId) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const supported = config?.environment.capabilities.promptStash === true;
  const localEntries = usePromptStashStore((state) => state.entries);
  const result = useAtomValue(
    supported ? serverEnvironment.promptStash({ environmentId, input: {} }) : emptyEntriesAtom,
  );
  const pendingLocalEntries = useMemo(
    () => localPromptStashEntriesForEnvironment(localEntries, environmentId),
    [localEntries, environmentId],
  );
  const entries = useMemo(() => {
    if (!supported) return localEntries.map(summarizePromptStashEntry);
    const saved = Option.getOrElse(AsyncResult.value(result), () => EMPTY_ENTRIES);
    const savedIds = new Set(saved.map((entry) => entry.id));
    return [
      ...saved,
      ...pendingLocalEntries
        .filter((entry) => !savedIds.has(entry.id))
        .map(summarizePromptStashEntry),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }, [supported, result, localEntries, pendingLocalEntries]);
  const save = useAtomCommand(serverEnvironment.savePromptStashEntry, { reportFailure: false });
  const remove = useAtomCommand(serverEnvironment.deletePromptStashEntry, { reportFailure: false });
  const get = useAtomCommand(serverEnvironment.getPromptStashEntry, { reportFailure: false });

  useEffect(() => {
    if (!supported || result._tag !== "Success" || localEntries.length === 0) return;
    // Legacy prompts had no environment. Import them into the first opened composer’s server;
    // uploaded files choose the environment that already owns their bytes.
    void migrateLocalPromptStash(
      environmentId,
      async (entry) => (await save({ environmentId, input: { entry } }))._tag === "Success",
    );
  }, [environmentId, supported, result, localEntries, save]);

  const stashEntry = useCallback(
    async (entry: PromptStashEntry) => {
      if (!supported) return usePromptStashStore.getState().stashEntry(entry);
      const saved = await save({ environmentId, input: { entry } });
      return {
        evicted: null,
        written: saved._tag === "Success",
        durable: saved._tag === "Success",
      };
    },
    [environmentId, supported, save],
  );

  const takeEntry = useCallback(
    async (id: string) => {
      if (!supported) return usePromptStashStore.getState().takeEntry(id);
      const removed = await remove({ environmentId, input: { id } });
      if (removed._tag === "Success") usePromptStashStore.getState().takeEntry(id);
      return {
        entry: entries.find((entry) => entry.id === id) ?? null,
        durable: removed._tag === "Success",
      };
    },
    [environmentId, supported, remove, entries],
  );

  const getEntry = useCallback(
    async (id: string) => {
      if (!supported)
        return usePromptStashStore.getState().entries.find((entry) => entry.id === id) ?? null;
      const pending = pendingLocalEntries.find((entry) => entry.id === id);
      const saved = Option.getOrElse(AsyncResult.value(result), () => EMPTY_ENTRIES);
      if (pending && !saved.some((entry) => entry.id === id)) return pending;
      const fetched = await get({ environmentId, input: { id } });
      return fetched._tag === "Success" ? fetched.value : null;
    },
    [environmentId, supported, get, pendingLocalEntries, result],
  );

  return { entries, stashEntry, takeEntry, getEntry };
}
