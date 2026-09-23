import type { MessageId, OrchestrationMessage, ProviderHistoryMessage } from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";

/**
 * Caps history loaded natively into a provider session at roughly 100k tokens so a
 * handed-off thread still fits every supported context window. Real threads' messages
 * stay far below it; older messages are dropped first when one does not.
 */
export const PROVIDER_HANDOFF_HISTORY_MAX_CHARS = 400_000;

/**
 * Leaves room for the user's own message and pasted-text attachments inside the
 * provider input limit when history has to travel as text in the first turn.
 */
export const PROVIDER_HANDOFF_TRANSCRIPT_MAX_CHARS = 60_000;

/**
 * The conversation a provider takes over, oldest first. Skips the message being sent,
 * in-flight output, and `/compact` commands.
 */
export function collectHandoffHistory(input: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly currentMessageId?: MessageId | undefined;
  readonly maxChars?: number;
}): ReadonlyArray<ProviderHistoryMessage> {
  const maxChars = input.maxChars ?? PROVIDER_HANDOFF_HISTORY_MAX_CHARS;
  const history = input.messages.flatMap((message): ProviderHistoryMessage[] => {
    if (message.id === input.currentMessageId || message.streaming) return [];
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = (
      message.role === "assistant" ? assistantCitationsToPlainText(message.text) : message.text
    ).trim();
    if (text.length === 0 || (message.role === "user" && text.toLowerCase() === "/compact")) {
      return [];
    }
    return [{ role: message.role, text }];
  });

  // Always keep the latest message, then walk back while the budget allows.
  let start = history.length - 1;
  let usedChars = history.at(-1)?.text.length ?? 0;
  while (start > 0 && usedChars + history[start - 1]!.text.length <= maxChars) {
    start -= 1;
    usedChars += history[start]!.text.length;
  }
  return history.slice(Math.max(start, 0));
}

/**
 * Prefixes the first turn with the conversation so far, for providers that cannot load
 * it natively. Returns the message unchanged when there is no history.
 */
export function buildProviderHandoffInput(input: {
  readonly history: ReadonlyArray<ProviderHistoryMessage>;
  readonly previousProviderName: string;
  readonly messageText: string;
  readonly maxTranscriptChars?: number;
}): { readonly text: string; readonly handedOffMessageCount: number } {
  const maxChars = input.maxTranscriptChars ?? PROVIDER_HANDOFF_TRANSCRIPT_MAX_CHARS;
  const entries = input.history.map((message) => `[${message.role}]\n${message.text}`);

  const kept: string[] = [];
  let usedChars = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (usedChars + entry.length > maxChars) {
      // Keep the tail of an oversized latest message rather than handing over nothing.
      if (kept.length === 0) {
        const label = entry.slice(0, entry.indexOf("\n") + 1);
        kept.push(`${label}…${entry.slice(entry.length - maxChars)}`);
      }
      break;
    }
    kept.unshift(entry);
    usedChars += entry.length + 2;
  }
  if (kept.length === 0) {
    return { text: input.messageText, handedOffMessageCount: 0 };
  }

  const omitted = entries.length - kept.length;
  const text = [
    "<conversation_handoff>",
    `This conversation started with ${input.previousProviderName} and is continuing with you. ` +
      "The earlier messages are below for context. The workspace already contains any changes made so far." +
      (omitted > 0 ? ` ${omitted} older message${omitted === 1 ? " was" : "s were"} omitted.` : ""),
    "",
    kept.join("\n\n"),
    "</conversation_handoff>",
    "",
    input.messageText,
  ].join("\n");
  return { text, handedOffMessageCount: kept.length };
}
