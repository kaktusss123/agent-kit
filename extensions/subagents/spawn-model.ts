/**
 * Spawn-time model resolution — the LLM/orchestration → runtime boundary for
 * `subagent` spawn (plain and workspace modes).
 *
 * A spawn names its child's model in exactly one of three ways:
 *
 * - `model`: Pi pattern syntax `provider/id[:thinking]`, resolved exactly
 *   against the registry (the user named a model);
 * - `role`: one of the fixed roles, resolved through the per-machine binding
 *   in `subagent-roles.json` (read fresh on every call);
 * - neither: the mode's default role — `owner` for workspace spawns,
 *   `helper` for plain spawns.
 *
 * An unbound role resolves to the live session model + current thinking;
 * that is the documented default. Every other failure — unknown or
 * unsupported model/thinking, a bound role that no longer resolves, an
 * unreadable or corrupt bindings file, an invalid parameter combination —
 * throws here, so the caller never starts a child for an unresolvable
 * target and there is no fallback.
 *
 * Pure module: no runtime imports (pi types only appear as structural
 * parameters), so bun tests can exercise the boundary directly.
 */
import {
	createExactModelMatcher,
	resolveModelSpec,
	type ModelLike,
	type ModelPair,
	type ModelSpecEnv,
	type ThinkingLevel,
} from "./model-spec";
import { isRole, loadRoleBindings, rolesPath, ROLES, type Role } from "./roles";

/** Spawn modes: `plain` (cwd) and `workspace` (RepoOwner). */
export type SpawnMode = "plain" | "workspace";

/** Structural view of the tool ctx needed for spawn-time resolution. */
export interface SpawnModelCtx {
	model?: { provider: string; id: string } | undefined;
	modelRegistry: { getAll(): ModelLike[] };
}

/** The spawn parameters that select a model. */
export interface SpawnModelRequest {
	model?: string | undefined;
	role?: string | undefined;
}

/** The role a spawn runs under, after mode defaults and validation. */
export function effectiveRole(mode: SpawnMode, role: string | undefined): Role {
	if (role !== undefined && !isRole(role)) {
		throw new Error(`Unknown role "${role}". Roles: ${ROLES.join(", ")}.`);
	}
	if (mode === "workspace") {
		if (role !== undefined && role !== "owner") {
			throw new Error(`Workspace spawns always run as role "owner"; role "${role}" is not valid here. Omit role or pass "owner".`);
		}
		return "owner";
	}
	if (role === "owner") {
		throw new Error('Role "owner" is for workspace spawns only; use "helper", "explore" or "review" on plain spawns.');
	}
	return role ?? "helper";
}

function sessionPair(ctx: SpawnModelCtx, currentThinking: ThinkingLevel): ModelPair {
	if (!ctx.model) throw new Error("no model resolved in the current session");
	return { model: `${ctx.model.provider}/${ctx.model.id}`, thinking: currentThinking };
}

/**
 * Resolve the concrete pair for one spawn. Throws on any failure; the
 * bindings file is read fresh per call and only when a role decides the
 * model.
 */
export function resolveSpawnPair(
	mode: SpawnMode,
	request: SpawnModelRequest,
	ctx: SpawnModelCtx,
	currentThinking: ThinkingLevel,
): ModelPair {
	if (request.model !== undefined && request.role !== undefined) {
		throw new Error("`model` and `role` are mutually exclusive: pass `model` when the user named a model, otherwise a role.");
	}
	const role = effectiveRole(mode, request.role);
	const env: ModelSpecEnv = {
		findModel: createExactModelMatcher(ctx.modelRegistry.getAll()),
		defaultThinking: currentThinking,
	};

	if (request.model !== undefined) {
		const outcome = resolveModelSpec(request.model, env);
		if (!outcome.ok) throw new Error(outcome.error);
		return outcome.pair;
	}

	const file = rolesPath();
	const bound = loadRoleBindings(file)[role];
	if (bound === undefined) return sessionPair(ctx, currentThinking);
	const outcome = resolveModelSpec(bound, env);
	if (!outcome.ok) {
		throw new Error(
			`Role "${role}" is bound to "${bound}" in ${file}, but it cannot be resolved:\n${outcome.error}\n` +
				`Fix: \`/subagent-role ${role} <provider/id[:thinking]>\` to rebind, or \`/subagent-role ${role} unset\` to use the session model.`,
		);
	}
	return outcome.pair;
}
