import { BookmarkIcon, CopyIcon, FileIcon, FileTextIcon, ImageIcon } from "lucide-react";
import { memo, useEffect, useRef, useState, type RefObject } from "react";
import type { EnvironmentId, PromptStashSummary } from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";

import { RelativeTime } from "../RelativeTime";
import { cn } from "~/lib/utils";
import { useEnvironments } from "~/state/environments";
import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";

const SNIPPET_MAX_CHARS = 90;

export interface StashCopyTarget {
  readonly id: EnvironmentId;
  readonly label: string;
}

function missingImageCount(entry: PromptStashSummary): number {
  return entry.droppedImageNames.length + (entry.unreadableImageNames?.length ?? 0);
}

function stashEntrySnippet(entry: PromptStashSummary): string {
  const trimmed = assistantCitationsToPlainText(entry.prompt).trim().replace(/\s+/g, " ");
  if (trimmed.length > 0) {
    return trimmed.length > SNIPPET_MAX_CHARS ? `${trimmed.slice(0, SNIPPET_MAX_CHARS)}…` : trimmed;
  }
  const imageCount = entry.imageCount + entry.droppedImageNames.length;
  const fileCount = entry.files?.length ?? 0;
  const attachmentCount = imageCount + fileCount;
  if (attachmentCount === 0) {
    return "(empty)";
  }
  const label = imageCount > 0 && fileCount > 0 ? "attachment" : fileCount > 0 ? "file" : "image";
  return `(${attachmentCount} ${label}${attachmentCount === 1 ? "" : "s"})`;
}

/**
 * The listener runs capture-phase on window so it wins over the composer's handlers while the
 * menu is open.
 */
export const ComposerStashMenu = memo(function ComposerStashMenu(props: {
  entries: ReadonlyArray<PromptStashSummary>;
  stashShortcutLabel: string | null;
  composerFormRef: RefObject<HTMLFormElement | null>;
  /** The environment these prompts are saved on. Omit to hide copying to other environments. */
  environmentId?: EnvironmentId;
  onRestore: (entry: PromptStashSummary) => void;
  onDelete: (entry: PromptStashSummary) => void;
  onCopyAll?: (target: StashCopyTarget) => void;
  onClose: () => void;
}) {
  const {
    entries,
    stashShortcutLabel,
    composerFormRef,
    environmentId,
    onRestore,
    onDelete,
    onCopyAll,
    onClose,
  } = props;
  const drawerRef = useRef<HTMLDivElement>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(entries[0]?.id ?? null);

  const highlightedEntry = entries.find((entry) => entry.id === highlightedId) ?? entries[0];

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const drawer = drawerRef.current;
      if (
        (drawer && event.composedPath().includes(drawer)) ||
        (event.target instanceof Element &&
          event.target.closest('[data-prompt-stash-badge="true"]'))
      ) {
        return;
      }
      onClose();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [onClose]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        !(target instanceof Node) ||
        (target !== document.body &&
          !(target instanceof Element && target.closest('[data-prompt-stash-badge="true"]')) &&
          !drawerRef.current?.contains(target) &&
          !composerFormRef.current?.querySelector('textarea, [role="textbox"]')?.contains(target))
      ) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (entries.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        const currentIndex = entries.findIndex((entry) => entry.id === highlightedEntry?.id);
        const offset = event.key === "ArrowDown" ? 1 : -1;
        const normalizedIndex = currentIndex >= 0 ? currentIndex : offset === 1 ? -1 : 0;
        const nextIndex = (normalizedIndex + offset + entries.length) % entries.length;
        setHighlightedId(entries[nextIndex]?.id ?? null);
        const nextButton =
          drawerRef.current?.querySelectorAll<HTMLButtonElement>("[data-stash-restore]")[nextIndex];
        nextButton?.scrollIntoView({ block: "nearest" });
        if (drawerRef.current?.contains(document.activeElement)) {
          nextButton?.focus({ preventScroll: true });
        }
        return;
      }
      if (event.key === "Enter") {
        // A focused control inside the row (the delete button) owns its own
        // activation; swallowing Enter here would restore instead of delete.
        if (event.target instanceof HTMLElement && event.target.closest("button[aria-label]")) {
          return;
        }
        if (!highlightedEntry) return;
        event.preventDefault();
        event.stopPropagation();
        onRestore(highlightedEntry);
        return;
      }
      if (event.key === "Backspace" && (event.metaKey || event.ctrlKey)) {
        if (!highlightedEntry) return;
        event.preventDefault();
        event.stopPropagation();
        onDelete(highlightedEntry);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [composerFormRef, entries, highlightedEntry, onClose, onDelete, onRestore]);

  return (
    <ComposerBanner.Root ref={drawerRef} data-composer-stash-drawer="true">
      <ComposerBanner.Row
        render={<button type="button" />}
        aria-label="Close stash"
        aria-expanded="true"
        onPointerDown={(event) => event.preventDefault()}
        onClick={onClose}
      >
        <ComposerBanner.Icon>
          <BookmarkIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="text-muted-foreground">Saved</ComposerBanner.Content>
        <ComposerBanner.Actions>
          <ComposerBanner.Count>{entries.length}</ComposerBanner.Count>
          <ComposerBanner.ToggleIcon expanded />
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
      <ComposerBanner.Scroll>
        <ComposerBanner.Children render={<ul role="list" />} aria-label="Stashed prompts">
          {entries.length === 0 ? (
            <ComposerBanner.Row render={<li />}>
              <ComposerBanner.Icon />
              <ComposerBanner.Content className="text-muted-foreground">
                Nothing stashed yet.
                {stashShortcutLabel
                  ? ` Press ${stashShortcutLabel} with a prompt in the composer to stash it.`
                  : null}
              </ComposerBanner.Content>
            </ComposerBanner.Row>
          ) : (
            entries.map((entry) => (
              <ComposerBanner.Row
                render={<li />}
                key={entry.id}
                data-stash-entry={entry.id}
                data-highlighted={highlightedEntry?.id === entry.id || undefined}
                className={cn(
                  "relative rounded-sm",
                  highlightedEntry?.id === entry.id && "bg-accent text-accent-foreground",
                )}
                onMouseMove={() => {
                  if (highlightedId !== entry.id) setHighlightedId(entry.id);
                }}
                onFocus={() => setHighlightedId(entry.id)}
              >
                <ComposerBanner.Icon>
                  <FileTextIcon />
                </ComposerBanner.Icon>
                <ComposerBanner.Content>
                  <button
                    type="button"
                    className="min-w-0 flex-1 cursor-pointer truncate text-left text-foreground/80 outline-none before:absolute before:inset-0 before:rounded-sm focus-visible:before:ring-2 focus-visible:before:ring-inset focus-visible:before:ring-ring"
                    data-stash-restore={entry.id}
                    aria-label={`Restore stashed prompt: ${stashEntrySnippet(entry)}`}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => onRestore(entry)}
                  >
                    {stashEntrySnippet(entry)}
                  </button>
                </ComposerBanner.Content>
                <ComposerBanner.Actions>
                  {missingImageCount(entry) > 0 ? (
                    <span className="shrink-0 text-warning-foreground">
                      {missingImageCount(entry)} image
                      {missingImageCount(entry) === 1 ? "" : "s"} dropped
                    </span>
                  ) : null}
                  {entry.imageCount > 0 ? (
                    <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                      <ImageIcon className="size-3" aria-hidden />
                      {entry.imageCount}
                    </span>
                  ) : null}
                  {(entry.files?.length ?? 0) > 0 ? (
                    <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                      <FileIcon className="size-3" aria-hidden />
                      {entry.files!.length}
                    </span>
                  ) : null}
                  <time
                    dateTime={entry.createdAt}
                    className="shrink-0 text-muted-foreground tabular-nums max-sm:hidden"
                  >
                    <RelativeTime timestamp={entry.createdAt} />
                  </time>
                  <ComposerBanner.Dismiss
                    className="z-10"
                    aria-label="Delete stashed prompt"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => onDelete(entry)}
                  />
                </ComposerBanner.Actions>
              </ComposerBanner.Row>
            ))
          )}
        </ComposerBanner.Children>
      </ComposerBanner.Scroll>
      {entries.length > 0 && environmentId && onCopyAll ? (
        <StashCopyFooter environmentId={environmentId} onCopyAll={onCopyAll} />
      ) : null}
    </ComposerBanner.Root>
  );
});

/**
 * Pinned below the list so it stays reachable. Environments that cannot take
 * copies stay listed, disabled, with the reason.
 */
function StashCopyFooter(props: {
  environmentId: EnvironmentId;
  onCopyAll: (target: StashCopyTarget) => void;
}) {
  const { environments } = useEnvironments();
  const targets = environments.filter(
    (environment) => environment.environmentId !== props.environmentId,
  );
  if (targets.length === 0) return null;
  return (
    <ComposerBanner.Row>
      <ComposerBanner.Icon>
        <CopyIcon />
      </ComposerBanner.Icon>
      <ComposerBanner.Content className="text-muted-foreground">Copy all to</ComposerBanner.Content>
      <ComposerBanner.Actions>
        {targets.map((environment) => {
          const unavailableReason =
            environment.connection.phase !== "connected" || environment.serverConfig === null
              ? "Not connected"
              : environment.serverConfig.environment.capabilities.promptStash !== true
                ? "Server needs an update"
                : null;
          return (
            <Button
              key={environment.environmentId}
              size="micro"
              variant="outline"
              disabled={unavailableReason !== null}
              title={unavailableReason ?? undefined}
              // Labelled buttons keep Enter from restoring the highlighted prompt.
              aria-label={`Copy all saved prompts to ${environment.label}`}
              // Keep focus in the composer, like the rest of the menu.
              onPointerDown={(event) => event.preventDefault()}
              onClick={() =>
                props.onCopyAll({ id: environment.environmentId, label: environment.label })
              }
            >
              {unavailableReason
                ? `${environment.label} (${unavailableReason})`
                : environment.label}
            </Button>
          );
        })}
      </ComposerBanner.Actions>
    </ComposerBanner.Row>
  );
}
