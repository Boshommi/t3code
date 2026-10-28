import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { AssistantCitation, type MessageId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

/** The citation covers the whole response, so jumping reuses citation navigation. */
export interface PinnedMessage {
  readonly citation: AssistantCitation;
  readonly messageCreatedAt: string;
}

type PinsByThreadKey = Record<string, ReadonlyArray<PinnedMessage>>;

interface PinnedMessagesState {
  pinsByThreadKey: PinsByThreadKey;
  sectionOpen: boolean;
  pin: (pin: PinnedMessage) => void;
  unpin: (threadRef: ScopedThreadRef, messageId: MessageId) => void;
  setSectionOpen: (open: boolean) => void;
}

const EMPTY_PINS: ReadonlyArray<PinnedMessage> = [];

export function insertPin(
  pins: ReadonlyArray<PinnedMessage>,
  pin: PinnedMessage,
): ReadonlyArray<PinnedMessage> {
  return [
    ...pins.filter((existing) => existing.citation.messageId !== pin.citation.messageId),
    pin,
  ].toSorted((left, right) => left.messageCreatedAt.localeCompare(right.messageCreatedAt));
}

const isCitation = Schema.is(AssistantCitation);

const isPinnedMessage = (value: unknown): value is PinnedMessage => {
  const pin = value as PinnedMessage | null;
  return !!pin && typeof pin.messageCreatedAt === "string" && isCitation(pin.citation);
};

export function migratePinnedMessages(persisted: unknown): {
  pinsByThreadKey: PinsByThreadKey;
  sectionOpen: boolean;
} {
  const state = persisted as Partial<PinnedMessagesState> | null;
  const pinsByThreadKey: PinsByThreadKey = {};
  for (const [threadKey, pins] of Object.entries(state?.pinsByThreadKey ?? {})) {
    const valid = Array.isArray(pins) ? pins.filter(isPinnedMessage) : [];
    if (valid.length > 0) pinsByThreadKey[threadKey] = valid;
  }
  return { pinsByThreadKey, sectionOpen: state?.sectionOpen === true };
}

export const usePinnedMessagesStore = create<PinnedMessagesState>()(
  persist(
    (set) => ({
      pinsByThreadKey: {},
      sectionOpen: false,
      pin: (pin) =>
        set((state) => {
          const threadKey = scopedThreadKey(pin.citation);
          return {
            pinsByThreadKey: {
              ...state.pinsByThreadKey,
              [threadKey]: insertPin(state.pinsByThreadKey[threadKey] ?? EMPTY_PINS, pin),
            },
          };
        }),
      unpin: (threadRef, messageId) =>
        set((state) => {
          const threadKey = scopedThreadKey(threadRef);
          const { [threadKey]: pins = EMPTY_PINS, ...rest } = state.pinsByThreadKey;
          const remaining = pins.filter((pin) => pin.citation.messageId !== messageId);
          return {
            pinsByThreadKey: remaining.length > 0 ? { ...rest, [threadKey]: remaining } : rest,
          };
        }),
      setSectionOpen: (sectionOpen) => set({ sectionOpen }),
    }),
    {
      name: "t3code:pinned-messages:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      merge: (persisted, current) => ({ ...current, ...migratePinnedMessages(persisted) }),
      partialize: ({ pinsByThreadKey, sectionOpen }) => ({ pinsByThreadKey, sectionOpen }),
    },
  ),
);

export function useThreadPins(threadRef: ScopedThreadRef | null): ReadonlyArray<PinnedMessage> {
  return usePinnedMessagesStore((state) =>
    threadRef ? (state.pinsByThreadKey[scopedThreadKey(threadRef)] ?? EMPTY_PINS) : EMPTY_PINS,
  );
}
