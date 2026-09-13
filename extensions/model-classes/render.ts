/**
 * Rendering for the `/model-class` command output.
 *
 * The bare command must be self-explanatory months later: the status table
 * plus the usage block, nothing else. There is deliberately no active-class
 * marker, no `*`, no "current class": after a switch the applied pair IS the
 * new `default` by definition, and equal `default`/`cheap`/`smart` rows are
 * allowed without any warning.
 *
 * Pure module: no pi imports.
 */
import type { ModelClassName, StoredClasses } from "./store";
import { MODEL_CLASS_USAGE } from "./parse";

/** One rendered status row: `default` is the live session pair. */
export interface ModelClassStatusRow {
	name: "default" | ModelClassName;
	/** Canonical model identifier, or `undefined` when the class is not set. */
	model?: string;
	thinking?: string;
}

const NAME_WIDTH = 8;

function pad(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/**
 * Render the `/model-class` status output: the three rows (missing classes
 * shown as `not set`) followed by the usage block.
 */
export function renderModelClassStatus(session: ModelClassStatusRow, stored: StoredClasses): string {
	const rows: ModelClassStatusRow[] = [
		session,
		{ name: "cheap", ...(stored.cheap ?? {}) },
		{ name: "smart", ...(stored.smart ?? {}) },
	];
	const modelWidth = Math.max(
		0,
		...rows.map((r) => (r.model ? r.model.length + 3 : 0)),
	);
	const lines = rows.map((r) => {
		const name = pad(r.name, NAME_WIDTH) + " ";
		if (!r.model) return `${name}not set`;
		const line = `${name}${pad(r.model, modelWidth)}${r.thinking ? ` ${r.thinking}` : ""}`;
		return line.trimEnd();
	});
	return ["Model classes", "", ...lines, "", MODEL_CLASS_USAGE].join("\n");
}

/** Short confirmation for `<cheap|smart> set`. */
export function renderSaved(name: ModelClassName, model: string, thinking: string): string {
	return `Saved ${name}: ${model}, ${thinking}`;
}

/** Short confirmation for a successful switch. */
export function renderSwitched(name: ModelClassName, model: string, thinking: string): string {
	return `Switched to ${name}: ${model}, ${thinking}`;
}
