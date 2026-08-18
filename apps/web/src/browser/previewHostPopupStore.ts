import { create } from "zustand";

interface PreviewHostPopupState {
  readonly openCount: number;
  readonly begin: () => void;
  readonly end: () => void;
}

export const usePreviewHostPopupStore = create<PreviewHostPopupState>()((set) => ({
  openCount: 0,
  begin: () => set((state) => ({ openCount: state.openCount + 1 })),
  end: () => set((state) => ({ openCount: Math.max(0, state.openCount - 1) })),
}));

export function selectPreviewHostPopupOpen(state: PreviewHostPopupState): boolean {
  return state.openCount > 0;
}
