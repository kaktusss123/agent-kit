/**
 * §34.2 State machine tests.
 *
 * Covers:
 *  - every allowed transition succeeds
 *  - invalid transitions throw InvalidTransitionError
 *  - terminal phases (completed, failed) have no outgoing transitions
 *  - applyTransition updates updatedAt
 */

import { describe, expect, test } from "bun:test";
import {
  applyTransition,
  canTransition,
  InvalidTransitionError,
  nextPhases,
  type Transition,
} from "../state.ts";
import type { TaskManifestV2 } from "../types.ts";

function mk(phase: TaskManifestV2["phase"]): TaskManifestV2 {
  return {
    schemaVersion: 2,
    id: "st",
    type: "feat",
    phase,
    primaryRepo: "p",
    repos: { p: { name: "p", role: "primary", sourcePath: "/x" } },
    sessions: {},
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

// Every legal (transition, from, to) tuple. Indexed by transition to make
// iteration exhaustive regardless of how many transitions leave each phase.
const LEGAL: Array<[Transition, TaskManifestV2["phase"], TaskManifestV2["phase"]]> = [
  ["discovery_to_ready", "discovery", "ready_for_approval"],
  ["ready_to_discovery", "ready_for_approval", "discovery"],
  ["ready_to_approved", "ready_for_approval", "approved"],
  ["approved_to_implementing", "approved", "implementing"],
  ["approved_to_discovery", "approved", "discovery"],
  ["implementing_to_blocked", "implementing", "blocked"],
  ["implementing_to_completed", "implementing", "completed"],
  ["blocked_to_implementing", "blocked", "implementing"],
  ["blocked_to_discovery", "blocked", "discovery"],
];

describe("allowed transitions", () => {
  for (const [transition, from, to] of LEGAL) {
    test(`${from} → ${to} via ${transition}`, () => {
      const m = mk(from);
      const before = m.updatedAt;
      applyTransition(m, transition);
      expect(m.phase).toBe(to);
      expect(m.updatedAt).not.toBe(before);
    });
  }
});

describe("canTransition", () => {
  test("returns true for legal pairs", () => {
    expect(canTransition("discovery", "discovery_to_ready")).toBe(true);
    expect(canTransition("implementing", "implementing_to_completed")).toBe(true);
  });
  test("returns false when transition name does not match from-phase", () => {
    expect(canTransition("discovery", "implementing_to_completed")).toBe(false);
    expect(canTransition("completed", "ready_to_approved")).toBe(false);
  });
});

describe("nextPhases", () => {
  test("reports only direct successors", () => {
    expect(nextPhases("discovery")).toEqual(["ready_for_approval"]);
    expect(nextPhases("ready_for_approval").sort()).toEqual(
      ["approved", "discovery"].sort(),
    );
    expect(nextPhases("completed")).toEqual([]);
    expect(nextPhases("failed")).toEqual([]);
  });
});

describe("invalid transitions", () => {
  test("discovery → approved is rejected", () => {
    const m = mk("discovery");
    expect(() => applyTransition(m, "ready_to_approved")).toThrow(InvalidTransitionError);
  });

  test("completed is terminal", () => {
    const m = mk("completed");
    expect(nextPhases("completed")).toEqual([]);
    expect(() => applyTransition(m, "implementing_to_blocked")).toThrow(InvalidTransitionError);
    expect(() => applyTransition(m, "implementing_to_completed")).toThrow(InvalidTransitionError);
  });

  test("failed is terminal", () => {
    const m = mk("failed");
    expect(nextPhases("failed")).toEqual([]);
    for (const t of [
      "discovery_to_ready",
      "ready_to_approved",
      "approved_to_implementing",
      "implementing_to_completed",
    ] as Transition[]) {
      expect(canTransition("failed", t)).toBe(false);
    }
  });

  test("implementing → discovery is rejected (no silent de-implementation)", () => {
    const m = mk("implementing");
    expect(() => applyTransition(m, "ready_to_discovery")).toThrow(InvalidTransitionError);
  });

  test("applyTransition reports from-phase in error", () => {
    const m = mk("implementing");
    try {
      applyTransition(m, "discovery_to_ready");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransitionError);
      expect((e as InvalidTransitionError).from).toBe("implementing");
      expect((e as InvalidTransitionError).transition).toBe("discovery_to_ready");
    }
  });
});
