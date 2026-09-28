/**
 * Rendering for the `/model-class` command output.
 *
 * The bare command must be self-explanatory months later: the status table
 * (live session pair + every saved class in storage order) plus the routing
 * table plus the usage block, nothing else. There is deliberately no
 * active-class marker, no `*`, no "current class": after a switch the
 * applied pair IS the new `default` by definition, and equal rows are
 * allowed without any warning.
 *
 * Routing entries pointing at missing classes are visibly flagged, never
 * hidden (SPEC R2).
 *
 * Pure module: no pi imports.
 */
import type { ModelPair, RouteTarget, RoutingTable, SpawnMode, StoredClasses } from "./store";
import { SPAWN_MODES } from "./store";
import { MODEL_CLASS_USAGE } from "./parse";

/** One rendered status row: `default` is the live session pair. */
export interface ModelClassStatusRow {
	name: "default" | string;
	/** Canonical model identifier, or `undefined` when the class is not set. */
	model?: string;
	thinking?: string;
}

const DEFAULT_NAME_WIDTH = 8; // "default" + padding

function pad(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/**
 * Render the routing table: both spawn modes always shown, `inherit` (with
 * the session-pair note) when a mode has no route, the resolved pair for
 * routed classes, and a visible MISSING CLASS flag for routes pointing at
 * classes that are not saved.
 */
export function renderRoutingTable(stored: StoredClasses, routing: RoutingTable): string {
	// `!== undefined` (not truthiness): a PRESENT-but-empty target (""
	// from a hand-edit) counts toward the width exactly like any other
	// routed name and must never silently disappear from the table.
	const routedNames = SPAWN_MODES.map((mode) => routing[mode]).filter(
		(name): name is string => name !== undefined,
	);
	const classWidth = Math.max("inherit".length, ...routedNames.map((n) => n.length)) + 2;
	const modeWidth = Math.max(...SPAWN_MODES.map((m) => m.length)) + 2;
	const lines = SPAWN_MODES.map((mode) => {
		const className = routing[mode];
		const head = pad(mode, modeWidth);
		// Absent entry → inherit. A present-but-empty target is SET state that
		// fails closed at spawn resolution (`resolveSpawnTarget` uses
		// `!== undefined`): it must render as NOT SAVED, never hide as
		// inheritance (SPEC R2).
		if (className === undefined) return `${head}${pad("inherit", classWidth)}(session pair)`;
		// `<empty>` keeps an empty-string target readable instead of
		// interpolating nothing into the line.
		const display = className === "" ? "<empty>" : className;
		// Own-property lookup: an inherited Object property (`constructor`, ...)
		// must render as NOT SAVED, never leak through as a pair.
		const pair: ModelPair | undefined = Object.hasOwn(stored, className) ? stored[className] : undefined;
		if (!pair) {
			return (
				`${head}${pad(display, classWidth)}` +
				`NOT SAVED — save it (\`/model-class ${display} set\`) ` +
				`or reset the route (\`/model-class route ${mode} inherit\`)`
			);
		}
		return `${head}${pad(display, classWidth)}(${pair.model}, ${pair.thinking})`;
	});
	return ["Routing (spawn-mode defaults)", "", ...lines].join("\n");
}

/**
 * Render the `/model-class` status output: the session row plus every saved
 * class (missing classes simply do not appear), the routing table, and the
 * usage block.
 */
export function renderModelClassStatus(
	session: ModelClassStatusRow,
	stored: StoredClasses,
	routing: RoutingTable,
): string {
	const names = Object.keys(stored);
	const nameWidth = Math.max(DEFAULT_NAME_WIDTH, ...names.map((n) => n.length + 2));
	const rows: ModelClassStatusRow[] = [session, ...names.map((name) => ({ name, ...stored[name] }))];
	const modelWidth = Math.max(
		0,
		...rows.map((r) => (r.model ? r.model.length + 3 : 0)),
	);
	const lines = rows.map((r) => {
		const name = pad(r.name, nameWidth) + " ";
		if (!r.model) return `${name}not set`;
		const line = `${name}${pad(r.model, modelWidth)}${r.thinking ? ` ${r.thinking}` : ""}`;
		return line.trimEnd();
	});
	return ["Model classes", "", ...lines, "", renderRoutingTable(stored, routing), "", MODEL_CLASS_USAGE].join("\n");
}

/** Short confirmation for `<class> set`. */
export function renderSaved(name: string, model: string, thinking: string): string {
	return `Saved ${name}: ${model}, ${thinking}`;
}

/** Short confirmation for a successful switch (also used by `next`/Ctrl+Alt+P). */
export function renderSwitched(name: string, model: string, thinking: string): string {
	return `Switched to ${name}: ${model}, ${thinking}`;
}

/** Short confirmation for `<class> unset`. */
export function renderUnset(name: string): string {
	return `Deleted model class ${name}`;
}

/** Short confirmation for `route <mode> <class|inherit>` (resolved pair when known). */
export function renderRouteSet(mode: SpawnMode, target: RouteTarget, pair?: ModelPair): string {
	if (target === "inherit") return `Routing ${mode}: inherit (session pair)`;
	const suffix = pair ? ` (${pair.model}, ${pair.thinking})` : "";
	return `Routing ${mode}: ${target}${suffix}`;
}
