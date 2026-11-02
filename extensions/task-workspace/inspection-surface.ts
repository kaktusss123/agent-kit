/**
 * Process-wide presence proof for the task-workspace read-only projection.
 *
 * `current.ts` computes the session-scoped current-task projection, but a
 * module that is merely importable is not a loaded runtime: Pi may run with
 * `--no-extensions` and only the explicit `-e` entries, so a consumer can
 * import this directory while the extension itself never ran. Anything that
 * announces the projection to another process (for example the optional
 * ZAVOD inspection provider) must therefore declare the capability only on a
 * POSITIVE signal from the owning extension — not from tool names, package
 * identity, or file presence.
 *
 * This marker is that signal. It lives on `globalThis` under a registered
 * symbol because Pi evaluates every extension entry through a fresh jiti
 * instance with `moduleCache: false`: module-level state would fork per graph
 * and per `/reload`, while the marker must be visible to every graph.
 */
export const TASK_WORKSPACE_SURFACE_KEY = Symbol.for("agentkit.task-workspace.inspection");
export const TASK_WORKSPACE_SURFACE_VERSION = 1 as const;

export type TaskWorkspaceInspectionSurface = {
	version: number;
	/** The graph that published this marker; only it may withdraw it. */
	owner: unknown;
};

const globalScope = globalThis as { [key: symbol]: TaskWorkspaceInspectionSurface | undefined };

/** Identifies this module copy: only the owning graph may clear the marker. */
const instanceToken: object = {};

/** Publish presence from the current graph (idempotent, latest graph wins). */
export function markTaskWorkspaceInspectionSurface(): void {
	globalScope[TASK_WORKSPACE_SURFACE_KEY] = { version: TASK_WORKSPACE_SURFACE_VERSION, owner: instanceToken };
}

/** Withdraw the marker, but never one published by a newer graph. */
export function clearTaskWorkspaceInspectionSurface(): void {
	if (globalScope[TASK_WORKSPACE_SURFACE_KEY]?.owner === instanceToken) {
		globalScope[TASK_WORKSPACE_SURFACE_KEY] = undefined;
	}
}

/** Presence proof for read-only inspection consumers; incompatible versions read as absent. */
export function taskWorkspaceInspectionSurfacePresent(): boolean {
	return globalScope[TASK_WORKSPACE_SURFACE_KEY]?.version === TASK_WORKSPACE_SURFACE_VERSION;
}
