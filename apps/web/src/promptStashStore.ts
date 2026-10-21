import { type EnvironmentId, PromptStashEntry } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { PersistedComposerImageAttachment } from "./composerDraftStore";
import { createMemoryStorage, type StateStorage } from "./lib/storage";

export type { PromptStashEntry };

export const PROMPT_STASH_STORAGE_KEY = "t3code:prompt-stash:v2";
const LEGACY_PROMPT_STASH_STORAGE_KEY = "t3code:prompt-stash:v1";
const PROMPT_STASH_STORAGE_VERSION = 2;
const MIGRATION_TARGETS_STORAGE_KEY = "t3code:prompt-stash:migration-targets:v1";

export const MAX_STASH_ENTRIES = 20;
/**
 * Budget for an entry's serialized attachment payload. localStorage is a
 * ~5MB origin-wide quota shared with the composer draft store, so oversized
 * images are dropped (tracked in `droppedImageNames`) rather than persisted.
 * Server-stored prompts keep the same budget.
 */
export const MAX_STASH_ENTRY_ATTACHMENT_CHARS = 2_700_000;

/**
 * Saved prompts live on the server when it supports them. This browser store
 * keeps prompts for servers that do not, and prompts saved before the server
 * did, until they migrate.
 */
const PersistedPromptStashState = Schema.Struct({
  entries: Schema.Array(PromptStashEntry),
});
type PersistedPromptStashState = typeof PersistedPromptStashState.Type;

const decodePersistedPromptStashState = Schema.decodeUnknownSync(PersistedPromptStashState);
const decodeMigrationTargets = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

/**
 * Older builds wrote entries before their images finished encoding. Any entry
 * that comes back from storage still pending was orphaned by a closed tab or a
 * crash mid-encode, so the count is settled here — otherwise the entry would
 * be stuck showing missing images it can never receive.
 */
function clearOrphanedPendingImages(
  entries: ReadonlyArray<PromptStashEntry>,
): ReadonlyArray<PromptStashEntry> {
  return entries.map((entry) => {
    if (!entry.pendingImageCount) return entry;
    const lostCount = entry.pendingImageCount;
    return {
      ...entry,
      pendingImageCount: 0,
      unreadableImageNames: [
        ...(entry.unreadableImageNames ?? []),
        ...Array.from(
          { length: lostCount },
          (_, index) => `image ${index + 1} (not saved before reload)`,
        ),
      ],
    };
  });
}

export function partitionStashAttachments(
  attachments: ReadonlyArray<PersistedComposerImageAttachment>,
): {
  kept: PersistedComposerImageAttachment[];
  droppedNames: string[];
} {
  const kept: PersistedComposerImageAttachment[] = [];
  const droppedNames: string[] = [];
  let usedChars = 0;
  for (const attachment of attachments) {
    if (usedChars + attachment.dataUrl.length > MAX_STASH_ENTRY_ATTACHMENT_CHARS) {
      droppedNames.push(attachment.name);
      continue;
    }
    usedChars += attachment.dataUrl.length;
    kept.push(attachment);
  }
  return { kept, droppedNames };
}

/**
 * Reading the `localStorage` property itself can throw `SecurityError` when
 * storage is blocked by policy or the page is a sandboxed iframe — so the
 * access has to be guarded, not just the get/set calls on it.
 */
function resolveBaseStorage(): { storage: StateStorage; durable: boolean } {
  try {
    if (typeof localStorage !== "undefined") {
      return { storage: localStorage, durable: true };
    }
  } catch {}
  return { storage: createMemoryStorage(), durable: false };
}

const { storage: baseStashStorage, durable: storageIsDurable } = resolveBaseStorage();

/**
 * Persists the queue, immediately rather than debounced. Stashing is a
 * deliberate, infrequent keystroke — not a per-character autosave — so there
 * is nothing to coalesce, and the caller clears the composer on the strength
 * of this write landing, which a debounce timer cannot honestly report.
 */
function persistEntries(entries: ReadonlyArray<PromptStashEntry>): {
  written: boolean;
  durable: boolean;
} {
  try {
    baseStashStorage.setItem(
      PROMPT_STASH_STORAGE_KEY,
      JSON.stringify({
        version: PROMPT_STASH_STORAGE_VERSION,
        state: { entries } satisfies PersistedPromptStashState,
      }),
    );
    return { written: true, durable: storageIsDurable };
  } catch (error) {
    console.error("[PROMPT-STASH] Could not persist stash (storage quota?).", error);
    return { written: false, durable: false };
  }
}

function readPersistedEntries(): ReadonlyArray<PromptStashEntry> | null {
  try {
    const raw = baseStashStorage.getItem(PROMPT_STASH_STORAGE_KEY);
    if (typeof raw !== "string" || raw.length === 0) return null;
    const parsed: unknown = JSON.parse(raw);
    const state = (parsed as { state?: unknown } | null)?.state;
    if (!state) return null;
    return clearOrphanedPendingImages(decodePersistedPromptStashState(state).entries);
  } catch {
    return null;
  }
}

interface PromptStashStoreState {
  entries: ReadonlyArray<PromptStashEntry>;
  stashEntry: (entry: PromptStashEntry) => {
    evicted: PromptStashEntry | null;
    /** False when the write failed outright (e.g. quota); nothing was kept. */
    written: boolean;
    /**
     * False when the write will not survive a reload: either it failed, or it
     * landed only in the in-memory fallback because localStorage is blocked.
     */
    durable: boolean;
  };
  /**
   * `durable` is false when the removal could not be persisted, meaning a
   * reload would resurrect the entry.
   */
  takeEntry: (entryId: string) => { entry: PromptStashEntry | null; durable: boolean };
}

export const usePromptStashStore = create<PromptStashStoreState>()((set, get) => ({
  entries: [],
  stashEntry: (entry) => {
    const nextEntries = [entry, ...get().entries];
    const evicted = nextEntries.length > MAX_STASH_ENTRIES ? (nextEntries.pop() ?? null) : null;
    const { written, durable } = persistEntries(nextEntries);
    // A rejected write must not leave the entry visible either: the caller
    // keeps the composer intact on failure, so a stashed copy would
    // duplicate the prompt. Eviction likewise only sticks on success.
    if (!written) {
      return { evicted: null, written: false, durable: false };
    }
    set(() => ({ entries: nextEntries }));
    return { evicted, written: true, durable };
  },
  takeEntry: (entryId) => {
    const entries = get().entries;
    const entry = entries.find((candidate) => candidate.id === entryId) ?? null;
    if (!entry) return { entry: null, durable: true };
    const nextEntries = entries.filter((candidate) => candidate.id !== entryId);
    const { durable } = persistEntries(nextEntries);
    set(() => ({ entries: nextEntries }));
    return { entry, durable };
  },
}));

{
  try {
    baseStashStorage.removeItem(LEGACY_PROMPT_STASH_STORAGE_KEY);
  } catch {}
  const persisted = readPersistedEntries();
  if (persisted) {
    usePromptStashStore.setState({ entries: persisted });
  }
}

export function writePromptStashStorageForTest(raw: string): void {
  baseStashStorage.setItem(PROMPT_STASH_STORAGE_KEY, raw);
  baseStashStorage.removeItem(MIGRATION_TARGETS_STORAGE_KEY);
  usePromptStashStore.setState({ entries: readPersistedEntries() ?? [] });
}

function readMigrationTargets(): Record<string, string> {
  try {
    const raw = baseStashStorage.getItem(MIGRATION_TARGETS_STORAGE_KEY);
    return typeof raw === "string" && raw.length > 0 ? decodeMigrationTargets(raw) : {};
  } catch {
    return {};
  }
}

function writeMigrationTargets(targets: Record<string, string>): void {
  baseStashStorage.setItem(MIGRATION_TARGETS_STORAGE_KEY, JSON.stringify(targets));
}

/**
 * The server a local entry belongs to: the one a migration already sent it to,
 * else the one that owns its uploaded files, else whichever server asks first.
 */
function migrationTarget(
  entry: PromptStashEntry,
  targets: Record<string, string>,
  environmentId: EnvironmentId,
): string {
  return targets[entry.id] ?? entry.files?.[0]?.environmentId ?? environmentId;
}

/** Local entries stay visible in their target environment until its server confirms the import. */
export function localPromptStashEntriesForEnvironment(
  entries: ReadonlyArray<PromptStashEntry>,
  environmentId: EnvironmentId,
): ReadonlyArray<PromptStashEntry> {
  if (entries.length === 0) return entries;
  const targets = readMigrationTargets();
  return entries.filter(
    (entry) => migrationTarget(entry, targets, environmentId) === environmentId,
  );
}

const migrationsInFlight = new Set<string>();

/**
 * Imports local entries into `environmentId`'s server, one acknowledgement at a
 * time. The local copy is removed only after the server confirms it. Each entry
 * is pinned to its first server before sending, so an interrupted import resumes
 * there instead of copying the prompt to a second environment.
 */
export async function migrateLocalPromptStash(
  environmentId: EnvironmentId,
  save: (entry: PromptStashEntry) => Promise<boolean>,
): Promise<void> {
  for (const entry of usePromptStashStore.getState().entries) {
    if (migrationsInFlight.has(entry.id)) continue;
    // Uploads from several environments cannot all be restored from one server.
    const fileEnvironmentId = entry.files?.[0]?.environmentId;
    if (entry.files?.some((file) => file.environmentId !== fileEnvironmentId)) continue;
    const targets = readMigrationTargets();
    if (migrationTarget(entry, targets, environmentId) !== environmentId) continue;
    migrationsInFlight.add(entry.id);
    try {
      writeMigrationTargets({ ...targets, [entry.id]: environmentId });
      if (!(await save(entry))) continue;
      if (usePromptStashStore.getState().takeEntry(entry.id).durable) {
        const { [entry.id]: _migrated, ...remaining } = readMigrationTargets();
        writeMigrationTargets(remaining);
      }
    } catch {
      // Keep the local copy. The next connection or list update retries.
    } finally {
      migrationsInFlight.delete(entry.id);
    }
  }
}
