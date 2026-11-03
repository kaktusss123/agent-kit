/** Core's logical non-terminal child states, independent of any consumer or
 * transport. Process liveness is a separate fact: callers that classify
 * confirmed activity must require `alive` as well. */
import type { AgentState } from "./types.ts";

export type RunningAgentState = Extract<AgentState, "starting" | "running" | "waiting_input">;

const RUNNING_STATES: ReadonlySet<string> = new Set<RunningAgentState>([
	"starting",
	"running",
	"waiting_input",
]);

export function isRunningAgentState(state: string): state is RunningAgentState {
	return RUNNING_STATES.has(state);
}
