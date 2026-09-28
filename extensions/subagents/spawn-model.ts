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
 * - the literal `"default"` and an omitted param with no readable routing
 *   resolve the live session pair WITHOUT consulting storage — saved-class
 *   storage can never break the inheritance path (corrupt file included);
 * - an explicit class name, or a routing entry, reads storage and throws on
 *   any failure (corrupt storage is never masked).
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
	let stored: StoredModelClasses;
	try {
		stored = loadStoredFile(modelClassesPath());
	} catch (e) {
		if (requested !== undefined) throw e; // explicit class: never masked
		// Omitted param with unreadable storage: no readable routing exists,
		// so the session pair applies — identical to today's inheritance
		// default. `/model-class` status surfaces the corruption loudly.
		return pairOrThrow(resolveSpawnTarget(mode, undefined, {}, {}, envFor(ctx, currentThinking)));
	}
	return pairOrThrow(resolveSpawnTarget(mode, requested, stored.classes, stored.routing, envFor(ctx, currentThinking)));
}

function pairOrThrow(outcome: { ok: true; pair: ModelPair } | { ok: false; error: string }): ModelPair {
	if (!outcome.ok) throw new Error(outcome.error);
	return outcome.pair;
}
