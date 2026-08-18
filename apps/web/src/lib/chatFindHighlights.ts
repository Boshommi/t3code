export const CHAT_FIND_MATCH_HIGHLIGHT = "t3-chat-find-match";
export const CHAT_FIND_CURRENT_HIGHLIGHT = "t3-chat-find-current";

function supportsCssHighlights(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function";
}

function walkTextNodes(root: Node, visit: (node: Text) => void): void {
  const iterator = document.createNodeIterator(root, NodeFilter.SHOW_TEXT);
  let node = iterator.nextNode();
  while (node) {
    if (node instanceof Text && node.data.length > 0) {
      visit(node);
    }
    node = iterator.nextNode();
  }
}

export function clearChatFindHighlights(): void {
  if (!supportsCssHighlights()) {
    return;
  }
  CSS.highlights.delete(CHAT_FIND_MATCH_HIGHLIGHT);
  CSS.highlights.delete(CHAT_FIND_CURRENT_HIGHLIGHT);
}

export function applyChatFindHighlights(input: {
  readonly root: Element | null;
  readonly query: string;
  readonly activeDocumentId: string | null;
  readonly activeOccurrence: number;
}): void {
  clearChatFindHighlights();
  if (!supportsCssHighlights() || !input.root) {
    return;
  }

  const needle = input.query.trim();
  if (needle.length === 0) {
    return;
  }
  const lowerNeedle = needle.toLowerCase();
  const matchRanges: Range[] = [];
  const currentRanges: Range[] = [];

  for (const documentRoot of input.root.querySelectorAll("[data-chat-find-id]")) {
    const documentId = documentRoot.getAttribute("data-chat-find-id");
    if (!documentId) {
      continue;
    }
    const scopes = documentRoot.querySelectorAll("[data-chat-find-text]");
    const roots = scopes.length > 0 ? scopes : [documentRoot];
    let occurrence = 0;

    for (const scope of roots) {
      walkTextNodes(scope, (textNode) => {
        const haystack = textNode.data.toLowerCase();
        let from = 0;
        while (from < haystack.length) {
          const at = haystack.indexOf(lowerNeedle, from);
          if (at === -1) {
            break;
          }
          const range = document.createRange();
          range.setStart(textNode, at);
          range.setEnd(textNode, at + needle.length);
          if (documentId === input.activeDocumentId && occurrence === input.activeOccurrence) {
            currentRanges.push(range);
          } else {
            matchRanges.push(range);
          }
          occurrence += 1;
          from = at + needle.length;
        }
      });
    }
  }

  if (matchRanges.length > 0) {
    CSS.highlights.set(CHAT_FIND_MATCH_HIGHLIGHT, new Highlight(...matchRanges));
  }
  if (currentRanges.length > 0) {
    CSS.highlights.set(CHAT_FIND_CURRENT_HIGHLIGHT, new Highlight(...currentRanges));
  }
}
