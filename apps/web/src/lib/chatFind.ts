import type { TurnId } from "@t3tools/contracts";

import { deriveDisplayedUserMessageState } from "./terminalContext";
import type { TimelineEntry } from "../session-logic";

export interface ChatFindDocument {
  readonly id: string;
  readonly kind: "message" | "proposed-plan" | "turn-plan";
  readonly turnId: TurnId | null;
  readonly text: string;
}

export interface ChatFindMatch {
  readonly documentId: string;
  readonly kind: ChatFindDocument["kind"];
  readonly turnId: TurnId | null;
  readonly occurrence: number;
  readonly start: number;
  readonly end: number;
}

export interface ChatFindReveal {
  readonly query: string;
  readonly documentId: string | null;
  readonly occurrence: number;
  readonly turnId: TurnId | null;
  readonly generation: number;
}

export function collectChatFindDocuments(
  entries: ReadonlyArray<TimelineEntry>,
): ChatFindDocument[] {
  const documents: ChatFindDocument[] = [];

  for (const entry of entries) {
    if (entry.kind === "message") {
      const { message } = entry;
      if (message.role !== "user" && message.role !== "assistant") {
        continue;
      }
      const text =
        message.role === "user"
          ? deriveDisplayedUserMessageState(message.text).visibleText
          : message.text;
      if (text.length === 0) {
        continue;
      }
      documents.push({
        id: message.id,
        kind: "message",
        turnId: message.turnId,
        text,
      });
      continue;
    }

    if (entry.kind === "proposed-plan") {
      const text = entry.proposedPlan.planMarkdown;
      if (text.length === 0) {
        continue;
      }
      documents.push({
        id: entry.id,
        kind: "proposed-plan",
        turnId: entry.proposedPlan.turnId,
        text,
      });
      continue;
    }

    if (entry.kind === "turn-plan") {
      const text = [
        entry.turnPlan.plan.explanation ?? "",
        ...entry.turnPlan.plan.steps.map((step) => step.step),
      ]
        .filter((part) => part.length > 0)
        .join("\n");
      if (text.length === 0) {
        continue;
      }
      documents.push({
        id: entry.id,
        kind: "turn-plan",
        turnId: entry.turnPlan.turnId,
        text,
      });
    }
  }

  return documents;
}

export function findChatFindMatches(
  documents: ReadonlyArray<ChatFindDocument>,
  query: string,
): ChatFindMatch[] {
  const needle = query.trim();
  if (needle.length === 0) {
    return [];
  }

  const lowerNeedle = needle.toLowerCase();
  const matches: ChatFindMatch[] = [];

  for (const document of documents) {
    const haystack = document.text.toLowerCase();
    let from = 0;
    let occurrence = 0;
    while (from < haystack.length) {
      const at = haystack.indexOf(lowerNeedle, from);
      if (at === -1) {
        break;
      }
      matches.push({
        documentId: document.id,
        kind: document.kind,
        turnId: document.turnId,
        occurrence,
        start: at,
        end: at + needle.length,
      });
      occurrence += 1;
      from = at + needle.length;
    }
  }

  return matches;
}

export function stepChatFindIndex(current: number, count: number, delta: 1 | -1): number {
  if (count <= 0) {
    return 0;
  }
  return (current + delta + count) % count;
}

export function formatChatFindCount(index: number, count: number): string {
  if (count === 0) {
    return "0/0";
  }
  return `${index + 1}/${count}`;
}
