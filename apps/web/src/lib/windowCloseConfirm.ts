export const WINDOW_CLOSE_CONFIRM_MS = 2000;

export function resolveWindowCloseConfirmAction(input: {
  readonly armedUntil: number | null;
  readonly now: number;
}): "confirm" | "close" {
  if (input.armedUntil !== null && input.now < input.armedUntil) {
    return "close";
  }
  return "confirm";
}
