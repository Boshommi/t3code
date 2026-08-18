// Tiny event bus so the command palette (and other chrome) can open in-chat
// find without owning ChatView state.
const CHAT_FIND_OPEN_EVENT = "t3code:open-chat-find";

export function openChatFind(): void {
  window.dispatchEvent(new Event(CHAT_FIND_OPEN_EVENT));
}

export function onOpenChatFind(listener: () => void): () => void {
  window.addEventListener(CHAT_FIND_OPEN_EVENT, listener);
  return () => window.removeEventListener(CHAT_FIND_OPEN_EVENT, listener);
}
