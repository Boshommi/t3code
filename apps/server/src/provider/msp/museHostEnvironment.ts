/**
 * museHostEnvironment — the process environment every `muse serve` host T3
 * spawns runs with.
 *
 * Muse launches "reminder" child agents (verify, goal, todo, memory, skill,
 * scope) after each model reply and keeps the turn open until they finish,
 * which is typically 45-65 seconds of silence after the answer is already on
 * screen. Each family is gated by an experimental environment flag the CLI
 * reads at startup; T3 clears them unless the user opts back in.
 *
 * @module provider/msp/museHostEnvironment
 */

/** One flag per reminder agent family Muse 1.3 ships. */
export const MUSE_REMINDER_AGENT_GATES: ReadonlyArray<string> = [
  "MUSE_EXPERIMENTAL_VERIFY_REMINDER",
  "MUSE_EXPERIMENTAL_GOAL_REMINDER",
  "MUSE_EXPERIMENTAL_TODO_REMINDER",
  "MUSE_EXPERIMENTAL_MEMORY_REMINDER",
  "MUSE_EXPERIMENTAL_SKILL_REMINDER",
  "MUSE_EXPERIMENTAL_SCOPE_REMINDER",
];

export function museHostEnvironment(
  environment: NodeJS.ProcessEnv,
  options: { readonly reminderAgents: boolean },
): NodeJS.ProcessEnv {
  if (options.reminderAgents) return environment;
  const gates = Object.fromEntries(MUSE_REMINDER_AGENT_GATES.map((gate) => [gate, "0"]));
  return { ...environment, ...gates };
}
