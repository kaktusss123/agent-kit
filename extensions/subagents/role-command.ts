/**
 * `/subagent-role` — manage per-machine role → model bindings without
 * editing files.
 *
 *   /subagent-role                              table of roles with their effective model
 *   /subagent-role <role> <provider/id[:thinking]>  validate against the registry, then save
 *   /subagent-role <role> current               save the current session model + thinking
 *   /subagent-role <role> unset                 remove the binding
 *
 * Pure module (no pi imports): the extension passes the live session facts
 * and renders the returned text.
 */
import {
	canonicalModelId,
	createExactModelMatcher,
	resolveModelSpec,
	type ModelLike,
	type ThinkingLevel,
} from "./model-spec";
import { isRole, loadRoleBindings, ROLES, ROLE_DESCRIPTIONS, saveRoleBinding, unsetRoleBinding } from "./roles";

export const SUBAGENT_ROLE_USAGE = [
	"Usage:",
	"  /subagent-role                                   show roles and their effective models",
	"  /subagent-role <role> <provider/id[:thinking]>   bind a role to a model (validated)",
	"  /subagent-role <role> current                    bind a role to the current session model + thinking",
	"  /subagent-role <role> unset                      remove the binding (role uses the session model)",
	`Roles: ${ROLES.join(", ")}`,
].join("\n");

export interface RoleCommandDeps {
	/** Bindings file. */
	file: string;
	/** Live session model, if any. */
	model: ModelLike | undefined;
	thinking: ThinkingLevel;
	registry: ModelLike[];
}

export interface RoleCommandResult {
	kind: "info" | "error";
	text: string;
}

function table(file: string): string {
	const bindings = loadRoleBindings(file);
	const rows = ROLES.map((r) => `  ${r.padEnd(8)} ${(bindings[r] ?? "session").padEnd(40)} ${ROLE_DESCRIPTIONS[r]}`);
	return ["Subagent roles (unbound = session model):", ...rows, "", `File: ${file}`].join("\n");
}

/** Execute one command line. Never throws: failures come back as `error` results. */
export function runRoleCommand(args: string, deps: RoleCommandDeps): RoleCommandResult {
	const err = (text: string): RoleCommandResult => ({ kind: "error", text });
	const parts = args.trim().split(/\s+/).filter(Boolean);
	try {
		if (parts.length === 0) return { kind: "info", text: table(deps.file) };
		const [role, value, ...extra] = parts;
		if (!isRole(role)) return err(`Unknown role "${role}". Roles: ${ROLES.join(", ")}.\n\n${SUBAGENT_ROLE_USAGE}`);
		if (value === undefined || extra.length > 0) return err(SUBAGENT_ROLE_USAGE);

		if (value === "unset") {
			const removed = unsetRoleBinding(deps.file, role);
			return { kind: "info", text: removed ? `Role "${role}" unbound; it now uses the session model.` : `Role "${role}" has no binding (nothing to remove).` };
		}

		let spec: string;
		if (value === "current") {
			if (!deps.model) return err("Cannot save: no model resolved in the current session.");
			spec = `${canonicalModelId(deps.model)}:${deps.thinking}`;
		} else {
			spec = value;
		}
		const outcome = resolveModelSpec(spec, {
			findModel: createExactModelMatcher(deps.registry),
			defaultThinking: deps.thinking,
		});
		if (!outcome.ok) return err(outcome.error);
		// Persist what was typed: a spec without thinking keeps meaning "the
		// parent's current level at spawn time".
		saveRoleBinding(deps.file, role, spec);
		return { kind: "info", text: `Role "${role}" bound to ${spec}.` };
	} catch (e) {
		return err(e instanceof Error ? e.message : String(e));
	}
}

/** Completion values for the command argument prefix. */
export function roleCommandCompletions(prefix: string): string[] {
	const values: string[] = [];
	for (const r of ROLES) values.push(r, `${r} current`, `${r} unset`);
	return values.filter((v) => v.startsWith(prefix));
}
