/**
 * Spawn-time model class resolution — the LLM/orchestration → runtime
 * boundary for `subagent spawn` (SPEC §6).
 *
 * The model picks a CLASS, never a concrete provider/model; this module is
 * the only place that turns `modelClass` into the concrete model + thinking
 * pair the child process needs, through the same resolver `/model-class`
 * uses (../model-classes/core). Resolution is fail closed: an unconfigured
 * class or a model that is no longer available throws here, so the caller
 * can never start a child for an unresolvable class and there is no
 * fallback.
 *
 * Pure module: no runtime imports (pi types only appear as structural
 * parameters), so bun tests can exercise the boundary directly.
 */
import { createExactModelMatcher, resolveModelClass, type ModelClassEnv, type ModelLike } from "../model-classes/core";
import { loadModelClasses, modelClassesPath, type ModelPair, type ThinkingLevel } from "../model-classes/store";

/** Model-facing spawn model selection: a class, never a concrete model. */
export type SpawnModelClass = "cheap" | "default" | "smart";

/** Structural view of the tool ctx needed for spawn-time class resolution. */
export interface SpawnModelCtx {
	model?: { provider: string; id: string } | undefined;
	modelRegistry: { getAll(): ModelLike[] };
}

/**
 * Resolve a spawn modelClass to the concrete pair the child needs. Storage
 * is read fresh per call and `default` snapshots the caller-provided live
 * session state (current model + thinking read at resolution time, never a
 * startup cache).
 */
export function resolveSpawnPair(ref: SpawnModelClass, ctx: SpawnModelCtx, currentThinking: ThinkingLevel): ModelPair {
	const stored = loadModelClasses(modelClassesPath());
	const env: ModelClassEnv = {
		currentPair: () =>
			ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}`, thinking: currentThinking } : null,
		findModel: createExactModelMatcher(ctx.modelRegistry.getAll()),
	};
	const resolved = resolveModelClass(ref, stored, env);
	if (!resolved.ok) throw new Error(resolved.error);
	return resolved.pair;
}
