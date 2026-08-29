/**
 * V2 task state machine.
 *
 * All phase transitions must go through `transition()`. Direct mutation of
 * `manifest.phase` from commands/tools is forbidden and is caught by the
 * `assertPhase` helpers below.
 */

import type { TaskManifestV2, TaskPhase } from "./types.ts";

export type Transition =
  | "discovery_to_ready"
  | "ready_to_discovery"
  | "ready_to_approved"
  | "approved_to_implementing"
  | "approved_to_discovery"
  | "implementing_to_blocked"
  | "implementing_to_completed"
  | "blocked_to_implementing"
  | "blocked_to_discovery";

const ALLOWED: Record<TaskPhase, TaskPhase[]> = {
  discovery: ["ready_for_approval"],
  ready_for_approval: ["discovery", "approved"],
  approved: ["implementing", "discovery"],
  implementing: ["blocked", "completed"],
  blocked: ["implementing", "discovery"],
  completed: [],
  failed: [],
};

const TRANSITION_MAP: Record<Transition, { from: TaskPhase; to: TaskPhase }> = {
  discovery_to_ready: { from: "discovery", to: "ready_for_approval" },
  ready_to_discovery: { from: "ready_for_approval", to: "discovery" },
  ready_to_approved: { from: "ready_for_approval", to: "approved" },
  approved_to_implementing: { from: "approved", to: "implementing" },
  approved_to_discovery: { from: "approved", to: "discovery" },
  implementing_to_blocked: { from: "implementing", to: "blocked" },
  implementing_to_completed: { from: "implementing", to: "completed" },
  blocked_to_implementing: { from: "blocked", to: "implementing" },
  blocked_to_discovery: { from: "blocked", to: "discovery" },
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: TaskPhase,
    public readonly transition: Transition,
  ) {
    super(`invalid transition "${transition}" from phase "${from}"`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: TaskPhase, t: Transition): boolean {
  const def = TRANSITION_MAP[t];
  if (def.from !== from) return false;
  return ALLOWED[from].includes(def.to);
}

/**
 * Apply a named transition to a manifest. Mutates in place and updates
 * `updatedAt`. Throws if the transition is not allowed from the current phase.
 */
export function applyTransition(
  manifest: TaskManifestV2,
  t: Transition,
): void {
  if (!canTransition(manifest.phase, t)) {
    throw new InvalidTransitionError(manifest.phase, t);
  }
  const def = TRANSITION_MAP[t];
  manifest.phase = def.to;
  manifest.updatedAt = new Date().toISOString();
}

/**
 * Assert-only helper: throws if `manifest.phase` is not in `allowed`.
 */
export function assertPhase(
  manifest: TaskManifestV2,
  ...allowed: TaskPhase[]
): void {
  if (!allowed.includes(manifest.phase)) {
    throw new Error(
      `phase guard failed: task "${manifest.id}" is in "${manifest.phase}", expected one of ${allowed.join(", ")}`,
    );
  }
}

/**
 * Pure helper used by tests and the readiness validator to enumerate legal
 * transitions out of a phase.
 */
export function nextPhases(from: TaskPhase): readonly TaskPhase[] {
  return ALLOWED[from];
}
