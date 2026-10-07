/**
 * Fresh-read model-default guidance for Main — the content of the
 * `subagent_model_defaults` system-prompt section maintained by the
 * subagents extension.
 *
 * The static tool texts (parameter descriptions, promptGuidelines) bake in
 * only the class NAMES captured at extension load; mid-session changes to
 * saved classes or routing would leave them stale. This section is rebuilt
 * from CURRENT storage on every `before_agent_start`: Pi diffs prompt
 * sections and appends a transcript delta only when the text actually
 * changed, so Main sees the real class/model pairs and effective spawn
 * defaults without a whole system-prompt replacement or repeated large
 * context — and only when they genuinely changed.
 *
 * Pure module: no pi imports, no fs — callers supply the fresh state.
 */
import { REPO_OWNER_DEFAULT_CLASS } from "../model-classes/core";
import type { ModelPair, RoutingTable, StoredClasses } from "../model-classes/store";

/** System-prompt section tag carrying this guidance. */
export const SPAWN_MODEL_SECTION = "subagent_model_defaults";

/** Fresh state the guidance renders from. */
export interface SpawnGuidanceState {
	classes: StoredClasses;
	routing: RoutingTable;
	/** Live session pair at build time, when one is resolved. */
	session: ModelPair | null;
}

function pairText(pair: ModelPair): string {
	return `${pair.model} (${pair.thinking})`;
}

function sessionText(session: ModelPair | null): string {
	return session ? `current session model ${pairText(session)}` : "the current session model";
}

function chainText(
	mode: "plain" | "repoOwner",
	state: SpawnGuidanceState,
): string {
	const routed = state.routing[mode];
	const parts: string[] = [];
	if (routed !== undefined) {
		const pair = Object.hasOwn(state.classes, routed) ? state.classes[routed] : undefined;
		parts.push(`route=${routed}${pair ? ` -> ${pairText(pair)}` : " (NOT SAVED — spawns fail closed)"}`);
	} else if (mode === "repoOwner") {
		parts.push("no route");
		const implicit = Object.hasOwn(state.classes, REPO_OWNER_DEFAULT_CLASS)
			? state.classes[REPO_OWNER_DEFAULT_CLASS]
			: undefined;
		parts.push(
			implicit
				? `implicit ${REPO_OWNER_DEFAULT_CLASS} -> ${pairText(implicit)}`
				: `no saved ${REPO_OWNER_DEFAULT_CLASS} -> ${sessionText(state.session)}`,
		);
	} else {
		parts.push(`no route -> ${sessionText(state.session)}`);
	}
	return parts.join(", ");
}

/**
 * Build the guidance section: saved classes with their concrete pairs, the
 * effective omitted-modelClass chain per spawn mode, and the soft usage
 * rule (omit on workspace unless the user asked for a class; heavy is the
 * normal RepoOwner class, smart suits review/complex reasoning).
 */
export function buildSpawnModelSection(state: SpawnGuidanceState): string {
	const lines: string[] = ["Subagent model defaults (fresh from /model-class storage):"];
	const names = Object.keys(state.classes);
	lines.push(
		names.length > 0
			? `saved classes: ${names.map((n) => `${n}=${pairText(state.classes[n]!)}`).join("; ")}`
			: "saved classes: none (modelClass accepts only \"default\")",
	);
	lines.push(`plain spawn, modelClass omitted: ${chainText("plain", state)}`);
	lines.push(`workspace (repoOwner) spawn, modelClass omitted: ${chainText("repoOwner", state)}`);
	lines.push(
		`Usage: omit modelClass on workspace (RepoOwner) spawns unless the user explicitly requests another class; ` +
			`on plain spawns you may pick a class yourself — smart suits review and complex/nontrivial reasoning. ` +
			`${REPO_OWNER_DEFAULT_CLASS} is the normal RepoOwner implementation class. ` +
			`An explicit modelClass or "default" (the live session model) always overrides these defaults.`,
	);
	return lines.join("\n");
}

/** Guidance text when storage cannot be read (routing state unknown). */
export function buildSpawnModelSectionError(cause: string): string {
	return (
		"Subagent model defaults: model-classes storage is unreadable, so routing state is unknown — " +
		"class-dependent spawns fail closed until it is repaired or deleted.\n" +
		`Cause: ${cause}`
	);
}
