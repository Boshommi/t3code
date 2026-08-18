import { useCallback, useEffect, useMemo, useState } from "react";

import { onOpenChatFind } from "~/chatFindBus";
import {
  collectChatFindDocuments,
  findChatFindMatches,
  stepChatFindIndex,
  type ChatFindReveal,
} from "~/lib/chatFind";
import type { TimelineEntry } from "~/session-logic";

export function useChatFind(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [index, setIndex] = useState(0);
  const [focusToken, setFocusToken] = useState(0);
  const [revealGeneration, setRevealGeneration] = useState(0);

  const documents = useMemo(() => collectChatFindDocuments(timelineEntries), [timelineEntries]);
  const matches = useMemo(
    () => (open ? findChatFindMatches(documents, query) : []),
    [documents, open, query],
  );
  const activeIndex = matches.length === 0 ? 0 : Math.min(index, matches.length - 1);
  const activeMatch = matches[activeIndex] ?? null;

  useEffect(() => {
    if (index !== activeIndex) {
      setIndex(activeIndex);
    }
  }, [activeIndex, index]);

  const bumpReveal = useCallback(() => {
    setRevealGeneration((value) => value + 1);
  }, []);

  const openFind = useCallback(() => {
    setOpen(true);
    setFocusToken((value) => value + 1);
    bumpReveal();
  }, [bumpReveal]);

  const closeFind = useCallback(() => {
    setOpen(false);
  }, []);

  const setQuery = useCallback(
    (nextQuery: string) => {
      setQueryState(nextQuery);
      setIndex(0);
      bumpReveal();
    },
    [bumpReveal],
  );

  const goNext = useCallback(() => {
    if (matches.length === 0) {
      return;
    }
    setIndex((current) => stepChatFindIndex(current, matches.length, 1));
    bumpReveal();
  }, [bumpReveal, matches.length]);

  const goPrevious = useCallback(() => {
    if (matches.length === 0) {
      return;
    }
    setIndex((current) => stepChatFindIndex(current, matches.length, -1));
    bumpReveal();
  }, [bumpReveal, matches.length]);

  useEffect(() => onOpenChatFind(openFind), [openFind]);

  const reveal = useMemo<ChatFindReveal | null>(() => {
    if (!open) {
      return null;
    }
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return null;
    }
    return {
      query: trimmed,
      documentId: activeMatch?.documentId ?? null,
      occurrence: activeMatch?.occurrence ?? 0,
      turnId: activeMatch?.turnId ?? null,
      generation: revealGeneration,
    };
  }, [activeMatch, open, query, revealGeneration]);

  return {
    open,
    query,
    setQuery,
    matches,
    activeIndex,
    activeMatch,
    focusToken,
    reveal,
    openFind,
    closeFind,
    goNext,
    goPrevious,
  };
}
