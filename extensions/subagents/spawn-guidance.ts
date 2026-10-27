/**
 * Fresh-read model-role guidance for Main — the content of the
 * `subagent_model_defaults` system-prompt section maintained by the
 * subagents extension.
 *
 * The section is rebuilt from CURRENT role bindings on every
 * `before_agent_start`: Pi diffs prompt sections and appends a transcript
 * delta only when the text actually changed, so Main sees the real effective
 * model per role without a whole system-prompt replacement or repeated large
 * context — and only when the bindings genuinely changed.
 *
 * Pure module: no pi imports, no fs — callers supply the fresh state.
 */
import { ROLES, ROLE_DESCRIPTIONS, type RoleBindings } from "./roles";

/** System-prompt section tag carrying this guidance. */
export const SPAWN_MODEL_SECTION = "subagent_model_defaults";

/** Fresh state the guidance renders from. */
export interface SpawnGuidanceState {
	bindings: RoleBindings;
}

/** The rule shared by the section and the static tool texts. */
export const SPAWN_MODEL_RULE =
	"If the user named a model, pass `model` (`provider/id[:thinking]`). Otherwise pick a role: " +
	"`review` for independent review, `explore` for cheap read-only research, omit for the default " +
	"(`helper` on plain spawns, `owner` on workspace spawns). `model` and `role` are mutually exclusive. " +
	"Do not pass `model` or `role` on owner dispatches unless the user asked for a specific model.";

/** Build the guidance section: roles with their effective models, then the usage rule. */
export function buildSpawnModelSection(state: SpawnGuidanceState): string {
	const lines: string[] = ["Subagent model roles (fresh from subagent-roles.json; unbound = the session model):"];
	for (const role of ROLES) {
		lines.push(`- ${role} (${ROLE_DESCRIPTIONS[role]}): ${state.bindings[role] ?? "session"}`);
	}
	lines.push(`Usage: ${SPAWN_MODEL_RULE}`);
	return lines.join("\n");
}

/** Guidance text when the bindings cannot be read. */
export function buildSpawnModelSectionError(cause: string): string {
	return (
		"Subagent model roles: the role bindings file is unreadable, so role-dependent spawns fail closed " +
		"until it is repaired or deleted (an explicit `model` still works).\n" +
		`Cause: ${cause}`
	);
}
