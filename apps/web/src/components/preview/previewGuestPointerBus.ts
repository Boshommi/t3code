const listeners = new Set<() => void>();

export function dispatchPreviewGuestPointer(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribePreviewGuestPointer(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
