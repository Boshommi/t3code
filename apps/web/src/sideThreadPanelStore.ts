/**
 * What the side-threads panel shows, per thread. Session state only: the side
 * threads themselves live in the thread read model and sync across devices.
 */
import type { MessageId } from "@t3tools/contracts";
import { create } from "zustand";

export type SideThreadPanelView =
  /** Every side thread, or only those started from `anchorMessageId`. */
  | { readonly kind: "list"; readonly anchorMessageId?: MessageId }
  /**
   * One side thread. `pendingQuestion` covers the moment between asking a new
   * question and its event arriving, so the panel never flashes empty.
   */
  | { readonly kind: "thread"; readonly sideThreadId: MessageId; readonly pendingQuestion?: string }
  /** Writing the first question of a new side thread. */
  | { readonly kind: "compose"; readonly anchorMessageId: MessageId | null };

const LIST_VIEW: SideThreadPanelView = { kind: "list" };

interface SideThreadPanelStoreState {
  viewByThreadKey: Record<string, SideThreadPanelView>;
  setView: (threadKey: string, view: SideThreadPanelView) => void;
}

export const useSideThreadPanelStore = create<SideThreadPanelStoreState>()((set) => ({
  viewByThreadKey: {},
  setView: (threadKey, view) =>
    set((state) => ({ viewByThreadKey: { ...state.viewByThreadKey, [threadKey]: view } })),
}));

export function useSideThreadPanelView(threadKey: string): SideThreadPanelView {
  return useSideThreadPanelStore((state) => state.viewByThreadKey[threadKey] ?? LIST_VIEW);
}
