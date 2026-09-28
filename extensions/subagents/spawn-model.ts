/**
 * Spawn-time model class resolution — the LLM/orchestration → runtime
 * boundary for `subagent` spawn (both plain and workspace modes).
 *
 * The model picks a CLASS, never a concrete provider/model; this module is
 * the only place that turns `modelClass` (or the mode's routing default)
 * into the concrete model + thinking pair the child process needs, through
 * the same resolver `/model-class` uses (../model-classes/core). Resolution
 * is fail closed: an unknown/unresolvable class or routing entry throws
 * here, so the caller can never start a child for an unresolvable target
 * and there is no fallback.
 *
 * Storage rules at this boundary:
 * - the literal `"default"` resolves the live session pair WITHOUT
 *   consulting storage — the escape hatch can never be broken by a storage
 *   problem;
 * - an omitted param with NO storage file (or an empty one) legitimately
 *   means "no routing": the session pair applies (loadStoredFile returns an
 *   empty table for that case without throwing);
 * - anything else reads storage, and a read failure (corrupt JSON,
 *   unreadable file) means the routing state is UNKNOWN, not absent — a
 *   possibly-routed mode must not silently downgrade to the session model,
 *   so the failure propagates with the file path and the fix named.
 *
 * Pure module: no runtime imports (pi types only appear as structural
 * parameters), so bun tests can exercise the boundary directly.
 */
import {
	createExactModelMatcher,
	resolveSpawnTarget,
	type ModelClassEnv,
	type ModelLike,
} from "../model-classes/core";
import {
	loadStoredFile,
	modelClassesPath,
	type ModelPair,
	type SpawnMode,
	type StoredModelClasses,
	type ThinkingLevel,
} from "../model-classes/store";

/** Structural view of the tool ctx needed for spawn-time class resolution. */
export interface SpawnModelCtx {
	model?: { provider: string; id: string } | undefined;
	modelRegistry: { getAll(): ModelLike[] };
}

function envFor(ctx: SpawnModelCtx, currentThinking: ThinkingLevel): ModelClassEnv {
	return {
		currentPair: () =>
			ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}`, thinking: currentThinking } : null,
		findModel: createExactModelMatcher(ctx.modelRegistry.getAll()),
	};
}

/**
 * Resolve the concrete pair for one spawn. `mode` selects the routing
 * default when `requested` is omitted; an explicit `requested` (a saved
 * class name or the literal `"default"`) overrides routing for both modes.
 * Storage is read fresh per call.
 */
export function resolveSpawnPair(
	mode: SpawnMode,
	requested: string | undefined,
	ctx: SpawnModelCtx,
	currentThinking: ThinkingLevel,
): ModelPair {
	if (requested === "default") {
		return pairOrThrow(resolveSpawnTarget(mode, "default", {}, {}, envFor(ctx, currentThinking)));
	}
	// Everything else reads storage fresh. A read failure is unknown routing
	// state, not absent routing: it must fail closed here rather than silently
	// downgrade a possibly-routed mode to the session pair (SPEC D4). Only a
	// missing/empty file legitimately means "no routing" — loadStoredFile
	// returns an empty table for that case without throwing.
	let stored: StoredModelClasses;
	try {
		stored = loadStoredFile(modelClassesPath());
	} catch (e) {
		throw new Error(
			`${e instanceof Error ? e.message : String(e)}\n` +
				`Spawn routing state is unknown, so the spawn is refused rather than silently inheriting the session model. ` +
				`Fix: repair the file so it is valid JSON, or delete it and re-save what you need ` +
				`(classes: \`/model-class <class> set\`; routing: \`/model-class route <mode> <class|inherit>\`).`,
		);
	}
	return pairOrThrow(resolveSpawnTarget(mode, requested, stored.classes, stored.routing, envFor(ctx, currentThinking)));
}

function pairOrThrow(outcome: { ok: true; pair: ModelPair } | { ok: false; error: string }): ModelPair {
	if (!outcome.ok) throw new Error(outcome.error);
	return outcome.pair;
}
