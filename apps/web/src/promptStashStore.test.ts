import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";

import { removeLocalStorageItem } from "./hooks/useLocalStorage";

import {
  MAX_STASH_ENTRIES,
  PROMPT_STASH_STORAGE_KEY,
  MAX_STASH_ENTRY_ATTACHMENT_CHARS,
  localPromptStashEntriesForEnvironment,
  migrateLocalPromptStash,
  partitionStashAttachments,
  usePromptStashStore,
  writePromptStashStorageForTest,
  type PromptStashEntry,
} from "./promptStashStore";

function makeEntry(input: {
  id: string;
  prompt?: string;
  attachmentChars?: number;
}): PromptStashEntry {
  return {
    id: input.id,
    createdAt: "2026-07-24T12:00:00.000Z",
    prompt: input.prompt ?? `prompt ${input.id}`,
    attachments:
      input.attachmentChars !== undefined
        ? [
            {
              id: `${input.id}-img`,
              name: "shot.png",
              mimeType: "image/png",
              sizeBytes: input.attachmentChars,
              dataUrl: "x".repeat(input.attachmentChars),
            },
          ]
        : [],
    droppedImageNames: [],
  };
}

function resetPromptStashStore() {
  usePromptStashStore.setState({ entries: [] });
  writePromptStashStorageForTest("");
  removeLocalStorageItem(PROMPT_STASH_STORAGE_KEY);
}

describe("partitionStashAttachments", () => {
  it("keeps attachments within the budget and reports dropped names in order", () => {
    const small = {
      id: "a",
      name: "small.png",
      mimeType: "image/png",
      sizeBytes: 10,
      dataUrl: "x".repeat(10),
    };
    const huge = {
      id: "b",
      name: "huge.png",
      mimeType: "image/png",
      sizeBytes: MAX_STASH_ENTRY_ATTACHMENT_CHARS,
      dataUrl: "x".repeat(MAX_STASH_ENTRY_ATTACHMENT_CHARS),
    };
    const alsoSmall = {
      id: "c",
      name: "also-small.png",
      mimeType: "image/png",
      sizeBytes: 10,
      dataUrl: "x".repeat(10),
    };
    const { kept, droppedNames } = partitionStashAttachments([small, huge, alsoSmall]);
    expect(kept.map((attachment) => attachment.id)).toEqual(["a", "c"]);
    expect(droppedNames).toEqual(["huge.png"]);
  });
});

describe("promptStashStore", () => {
  beforeEach(() => {
    resetPromptStashStore();
  });

  afterEach(() => {
    resetPromptStashStore();
  });

  it("restores citations and bound comments from a persisted stash", () => {
    const citation = {
      version: 1 as const,
      environmentId: EnvironmentId.make("remote-source"),
      threadId: ThreadId.make("source-thread"),
      messageId: MessageId.make("source-message"),
      text: "A quote to revisit later.",
      comment: "Revisit this tomorrow.\nCheck whether the example still applies.",
      start: 0,
      end: 24,
      prefix: "",
      suffix: " Next.",
    };
    const prompt = `Revisit ${serializeAssistantCitation(citation)}`;
    writePromptStashStorageForTest(
      JSON.stringify({
        version: 2,
        state: { entries: [makeEntry({ id: "citation-stash", prompt })] },
      }),
    );
    const restored = usePromptStashStore.getState().takeEntry("citation-stash").entry;
    expect(restored?.prompt).toBe(prompt);
    expect(
      collectAssistantCitations(restored?.prompt ?? "").map((entry) => entry.citation),
    ).toEqual([citation]);
    expect(usePromptStashStore.getState().takeEntry("citation-stash").entry).toBeNull();
  });

  it("evicts the oldest entry past the cap and returns it", () => {
    const store = usePromptStashStore.getState();
    for (let index = 0; index < MAX_STASH_ENTRIES; index += 1) {
      expect(store.stashEntry(makeEntry({ id: `entry-${index}` })).evicted).toBeNull();
    }
    const { evicted } = store.stashEntry(makeEntry({ id: "overflow" }));
    expect(evicted?.id).toBe("entry-0");
    const entries = usePromptStashStore.getState().entries;
    expect(entries).toHaveLength(MAX_STASH_ENTRIES);
    expect(entries[0]?.id).toBe("overflow");
  });

  // regression: #4787 stashed prompts were lost when switching providers
  it("distinguishes a memory-only write (written, not durable) from a failed one", () => {
    const store = usePromptStashStore.getState();
    const result = store.stashEntry(makeEntry({ id: "memory-only" }));
    expect(result.written).toBe(true);
    expect(result.durable).toBe(false);
    expect(usePromptStashStore.getState().entries.map((entry) => entry.id)).toEqual([
      "memory-only",
    ]);
  });

  it("preserves uploaded file references without storing file contents", () => {
    const file = {
      id: "file-1",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      attachmentId: "pending-report-pdf",
      environmentId: EnvironmentId.make("environment-1"),
    };

    writePromptStashStorageForTest(
      JSON.stringify({
        version: 2,
        state: { entries: [{ ...makeEntry({ id: "with-file" }), files: [file] }] },
      }),
    );

    expect(usePromptStashStore.getState().entries[0]?.files).toEqual([file]);
  });

  it("settles a pending count left behind by a crashed or closed session", () => {
    writePromptStashStorageForTest(
      JSON.stringify({
        version: 2,
        state: {
          entries: [{ ...makeEntry({ id: "orphan" }), pendingImageCount: 2 }],
        },
      }),
    );

    const entry = usePromptStashStore.getState().entries[0];
    expect(entry?.pendingImageCount).toBe(0);
    expect(entry?.unreadableImageNames).toHaveLength(2);
  });

  it("ignores an unreadable v1 payload seeded under the current key", () => {
    writePromptStashStorageForTest(
      JSON.stringify({
        version: 1,
        state: { queuesByScopeKey: { "provider:claudeAgent": [] } },
      }),
    );
    expect(usePromptStashStore.getState().entries).toEqual([]);
  });
});

describe("prompt stash context records", () => {
  it("restores the records behind a persisted prompt's chips", () => {
    const records = [
      {
        version: 1 as const,
        contextId: "ctx-1" as never,
        kind: "terminal" as const,
        label: "Terminal 1 line 4",
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "boom",
      },
    ];
    writePromptStashStorageForTest(
      JSON.stringify({
        version: 2,
        state: {
          entries: [
            {
              id: "entry-records",
              createdAt: "2026-01-01T00:00:00.000Z",
              prompt: "see [Terminal 1 line 4](t3-context://v1/terminal/ctx-1)",
              attachments: [],
              droppedImageNames: [],
              records,
            },
          ],
        },
      }),
    );
    const taken = usePromptStashStore.getState().takeEntry("entry-records");
    expect(taken.entry?.records).toEqual(records);
  });
});

describe("server migration", () => {
  beforeEach(resetPromptStashStore);
  afterEach(resetPromptStashStore);

  it("removes only entries the server acknowledged", async () => {
    const environmentId = EnvironmentId.make("migration-server");
    usePromptStashStore.getState().stashEntry(makeEntry({ id: "migration-fail" }));
    usePromptStashStore.getState().stashEntry(makeEntry({ id: "migration-ok" }));
    const saved: string[] = [];
    await migrateLocalPromptStash(environmentId, async (entry) => {
      saved.push(entry.id);
      return entry.id === "migration-ok";
    });
    expect(saved).toEqual(["migration-ok", "migration-fail"]);
    expect(usePromptStashStore.getState().entries.map((entry) => entry.id)).toEqual([
      "migration-fail",
    ]);
    await migrateLocalPromptStash(environmentId, async () => true);
    expect(usePromptStashStore.getState().entries).toEqual([]);
  });

  it("pins an interrupted migration to its server and routes uploaded files to their owner", async () => {
    const first = EnvironmentId.make("migration-first");
    const second = EnvironmentId.make("migration-second");
    usePromptStashStore.getState().stashEntry(makeEntry({ id: "migration-pinned" }));
    await migrateLocalPromptStash(first, async () => false);
    const saved: string[] = [];
    const record = async (entry: PromptStashEntry) => {
      saved.push(entry.id);
      return true;
    };
    await migrateLocalPromptStash(second, record);
    expect(saved).toEqual([]);
    const entries = () => usePromptStashStore.getState().entries;
    expect(localPromptStashEntriesForEnvironment(entries(), first).map(({ id }) => id)).toEqual([
      "migration-pinned",
    ]);
    expect(localPromptStashEntriesForEnvironment(entries(), second)).toEqual([]);

    usePromptStashStore.getState().stashEntry({
      ...makeEntry({ id: "migration-file" }),
      files: [
        {
          id: "file",
          name: "a.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1,
          attachmentId: "upload",
          environmentId: second,
        },
      ],
    });
    await migrateLocalPromptStash(first, record);
    expect(saved).toEqual(["migration-pinned"]);
    await migrateLocalPromptStash(second, record);
    expect(saved).toEqual(["migration-pinned", "migration-file"]);
  });

  it("does not send one entry twice when several composers start migrating", async () => {
    usePromptStashStore.getState().stashEntry(makeEntry({ id: "migration-concurrent" }));
    const environmentId = EnvironmentId.make("migration-concurrent-server");
    let resolveSave!: (saved: boolean) => void;
    let calls = 0;
    const save = () => {
      calls++;
      return new Promise<boolean>((resolve) => {
        resolveSave = resolve;
      });
    };
    const first = migrateLocalPromptStash(environmentId, save);
    await migrateLocalPromptStash(environmentId, save);
    expect(calls).toBe(1);
    resolveSave(true);
    await first;
    expect(usePromptStashStore.getState().entries).toEqual([]);
  });
});
