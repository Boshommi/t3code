import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { formatChatFindCount } from "~/lib/chatFind";

import { Button } from "../ui/button";
import { cn } from "~/lib/utils";

interface ChatFindBarProps {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly matchIndex: number;
  readonly matchCount: number;
  readonly focusToken: number;
  readonly onClose: () => void;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
}

export function ChatFindBar({
  query,
  onQueryChange,
  matchIndex,
  matchCount,
  focusToken,
  onClose,
  onNext,
  onPrevious,
}: ChatFindBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    input.select();
  }, [focusToken]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) {
        onPrevious();
      } else {
        onNext();
      }
    }
  };

  const countLabel = formatChatFindCount(matchIndex, matchCount);
  const hasQuery = query.trim().length > 0;

  return (
    <div
      className={cn(
        "dropdown-glass pointer-events-auto absolute top-2 right-2 z-30 flex w-[min(20rem,calc(100%-1rem))] items-center gap-0.5 rounded-lg p-1 shadow-xl shadow-black/25 sm:top-3 sm:right-5 [-webkit-app-region:no-drag]",
      )}
      data-chat-find-bar=""
      role="search"
    >
      <SearchIcon className="ms-1.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find"
        aria-label="Find in chat"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        className="h-7 min-w-0 flex-1 bg-transparent px-1.5 text-sm text-foreground outline-none placeholder:text-placeholder [&::-webkit-search-cancel-button]:hidden"
      />
      <span
        className={cn(
          "min-w-10 shrink-0 px-1 text-center text-xs tabular-nums",
          hasQuery && matchCount === 0 ? "text-destructive" : "text-muted-foreground",
        )}
        aria-live="polite"
      >
        {hasQuery ? countLabel : ""}
      </span>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Previous match"
        disabled={matchCount === 0}
        onClick={onPrevious}
      >
        <ChevronUpIcon />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Next match"
        disabled={matchCount === 0}
        onClick={onNext}
      >
        <ChevronDownIcon />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Close find"
        onClick={onClose}
      >
        <XIcon />
      </Button>
    </div>
  );
}
