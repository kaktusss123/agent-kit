import type { RunStage, RunStatus, TaskPhase, TcsfRun, TcsfTask } from "./types.ts";

export const TERMINAL_TASK_PHASES: Partial<Record<TaskPhase, true>> = { ready_for_acceptance: true, completed: true, failed: true, cancelled: true };
export const TERMINAL_RUN_STATUSES: Partial<Record<RunStatus, true>> = { terminal: true, failed: true, cancelled: true };

const TASK_TRANSITIONS: Partial<Record<TaskPhase, readonly TaskPhase[]>> = {
  approved: ["preparing", "cancelled"], preparing: ["implementing", "failed", "cancelled"],
  implementing: ["verifying", "waiting_for_decision", "waiting_for_operator", "failed", "cancelled"],
  verifying: ["implementing", "reviewing", "waiting_for_decision", "waiting_for_operator", "failed", "cancelled"],
  reviewing: ["implementing", "candidate_validating", "waiting_for_decision", "waiting_for_operator", "failed", "cancelled"],
  candidate_validating: ["implementing", "ready_for_acceptance", "waiting_for_decision", "waiting_for_operator", "failed", "cancelled"],
  waiting_for_decision: ["implementing", "verifying", "reviewing", "candidate_validating", "failed", "cancelled"],
  waiting_for_operator: ["implementing", "verifying", "reviewing", "candidate_validating", "failed", "cancelled"],
  ready_for_acceptance: ["completed"],
};
const RUN_TRANSITIONS: Partial<Record<RunStage, readonly RunStage[]>> = {
  import_contract: ["validate"], validate: ["prepare_workspaces"], prepare_workspaces: ["implement"],
  implement: ["verify", "waiting_for_decision", "waiting_for_operator", "failed"],
  verify: ["implement", "review", "waiting_for_decision", "waiting_for_operator", "failed"],
  review: ["implement", "candidate_validate", "waiting_for_decision", "waiting_for_operator", "failed"],
  candidate_validate: ["implement", "ready_for_acceptance", "waiting_for_decision", "waiting_for_operator", "failed"],
  waiting_for_decision: ["implement", "verify", "review", "candidate_validate", "failed"],
  waiting_for_operator: ["implement", "verify", "review", "candidate_validate", "failed"],
  ready_for_acceptance: ["completed"],
};

export function canTransitionTask(from: TaskPhase, to: TaskPhase): boolean { return TASK_TRANSITIONS[from]?.includes(to) ?? false; }
export function canTransitionRun(from: RunStage, to: RunStage): boolean { return RUN_TRANSITIONS[from]?.includes(to) ?? false; }
export function transitionTask(task: TcsfTask, to: TaskPhase): TcsfTask {
  if (!canTransitionTask(task.phase, to)) throw new Error(`invalid task transition ${task.phase} -> ${to}`);
  return { ...task, phase: to, revision: task.revision + 1, updatedAt: new Date().toISOString() };
}
export function transitionRun(run: TcsfRun, to: RunStage): TcsfRun {
  if (!canTransitionRun(run.currentStage, to)) throw new Error(`invalid run transition ${run.currentStage} -> ${to}`);
  return { ...run, currentStage: to, revision: run.revision + 1, updatedAt: new Date().toISOString() };
}
export function assertNotTerminal(task: TcsfTask): void { if (TERMINAL_TASK_PHASES[task.phase]) throw new Error(`task is terminal: ${task.phase}`); }
export function assertRunActive(run: TcsfRun): void { if (TERMINAL_RUN_STATUSES[run.status]) throw new Error(`run is terminal: ${run.status}`); }
