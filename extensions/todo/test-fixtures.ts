import type { TodoPhase, TodoStatus } from "./core";

/** Fixture builder: `phasesWith({ name, tasks: [["content", "status"]] })`. */
export function phasesWith(
	...defs: Array<{ name: string; tasks: Array<[string, TodoStatus]> }>
): TodoPhase[] {
	return defs.map(def => ({
		name: def.name,
		tasks: def.tasks.map(([content, status]) => ({ content, status })),
	}));
}
