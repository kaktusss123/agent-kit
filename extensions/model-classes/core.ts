/**
 * Model class resolution — the single mechanism behind `/model-class`,
 * Ctrl+Alt+P cycling, and `subagent(modelClass=...)` spawn routing.
 *
 * Semantics:
 *
 *   default -> snapshot of the CURRENT main session model + thinking, read
 *              at resolution time (never cached at startup);
 *   <name>  -> a user-named persisted class (any number of them).
 *
 * `default` is not a profile: it is whatever Pi is running right now. After
 * a successful switch to a saved class the applied pair automatically IS
 * the new `default`; there is no notion of an "active class".
 *
 * Spawn routing (one matrix for both spawn modes — the mode only selects
 * the routing default):
 *
 *   explicit modelClass  -> "default" (session pair) or a saved class name,
 *                           validated against the registry; anything else
 *                           fails closed listing the saved names;
 *   omitted modelClass   -> routing[mode] if set (resolved and validated
 *                           identically; unresolvable routes fail closed
 *                           naming class, mode, and fix), else the session
 *                           pair.
 *
 * Resolution validates the whole target combination (model exists in the
 * registry AND the stored thinking level is supported by that model) before
 * anything is applied. There is no fallback: not to `default`, not to
 * another provider/model, and no automatic reasoning downgrade.
 *
 * Pure module: no pi imports — Pi-bound callers supply the environment.
 */
import type { ModelPair, RoutingTable, SpawnMode, StoredClasses, ThinkingLevel } from "./store";
import { isThinkingLevel } from "./store";

/** Minimal structural view of a registry model needed for validation. */
export interface ModelLike {
	provider: string;
	id: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<string, string | null>>;
}

/** Pi-bound environment the resolver needs. */
export interface ModelClassEnv {
	/**
	 * The live session pair, read when called — never a startup snapshot.
	 * `null` when the session has no resolved model.
	 */
	currentPair(): ModelPair | null;
	/** Registry lookup for a stored canonical `<provider>/<modelId>`. */
	findModel(model: string): ModelLike | undefined;
}

export type ResolveOutcome =
	| {
			ok: true;
			pair: ModelPair;
			/** Which stored state produced the pair. */
			origin: "session" | "stored";
			/** The matched registry model for stored classes (session pairs resolve to ctx.model). */
			model?: ModelLike;
			/** Set when the pair came from the mode's routing default. */
			route?: { mode: SpawnMode; className: string };
	  }
	| { ok: false; error: string };

/** All thinking levels a model actually supports (mirrors pi-ai `getSupportedThinkingLevels`). */
export function supportedThinkingLevels(model: ModelLike): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return (["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/** Canonical identifier for a registry model. */
export function canonicalModelId(model: ModelLike): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Exact matcher for a stored canonical identifier against the model
 * catalogue. Mirrors pi's own exact-reference matching: a case-insensitive
 * full `provider/modelId` match wins (this correctly handles model ids that
 * themselves contain slashes), then an explicit first-slash provider/id
 * split. No fuzzy matching — an identifier that does not exist anymore must
 * fail, never silently resolve to a different model.
 */
export function createExactModelMatcher(models: ModelLike[]): (model: string) => ModelLike | undefined {
	const canonical = new Map<string, ModelLike>();
	const pairs = new Map<string, ModelLike>();
	for (const m of models) {
		const full = canonicalModelId(m);
		canonical.set(full.toLowerCase(), m);
		const slash = full.indexOf("/");
		if (slash !== -1) {
			const key = `${full.slice(0, slash).toLowerCase()}\u0000${full.slice(slash + 1).toLowerCase()}`;
			if (!pairs.has(key)) pairs.set(key, m);
		}
	}
	return (model) => {
		const norm = model.trim().toLowerCase();
		const direct = canonical.get(norm);
		if (direct) return direct;
		const slash = norm.indexOf("/");
		if (slash === -1) return undefined;
		return pairs.get(`${norm.slice(0, slash)}\u0000${norm.slice(slash + 1)}`);
	};
}

/** Comma-joined saved class names, or a note that none are saved. */
function savedNamesList(stored: StoredClasses): string {
	const names = Object.keys(stored);
	return names.length > 0 ? names.join(", ") : "none are saved yet";
}

/**
 * Error for a class reference that is not saved (typo, never configured, or
 * removed): lists the saved class names so the caller can self-correct.
 */
export function unknownClassError(ref: string, stored: StoredClasses): string {
	return (
		`Model class "${ref}" is not saved.\n` +
		`Saved classes: ${savedNamesList(stored)}.\n` +
		`Pick a saved name, or save it first: \`/model-class ${ref} set\`.`
	);
}

/** Error wrapper for a routing default that cannot be resolved (SPEC D4). */
export function routingFailureError(mode: SpawnMode, className: string, cause: string): string {
	return (
		`Spawn routing for mode "${mode}" is set to class "${className}", but it cannot be resolved:\n${cause}\n` +
		`Fix: \`/model-class route ${mode} <class|inherit>\` to change or reset the route, ` +
		`or re-save the class with \`/model-class ${className} set\`.`
	);
}

/**
 * Resolve a SAVED-CLASS reference (no `default` special case): own-property
 * lookup — inherited Object properties (`constructor`, `toString`, ...) must
 * behave exactly like unknown class names, never leak through as a class.
 * Routing uses this directly: a routed value is looked up as a saved class
 * ONLY, so a hand-edited `"default"` target fails closed instead of being
 * silently reinterpreted as the session pair.
 */
function resolveStoredClass(name: string, stored: StoredClasses, env: ModelClassEnv): ResolveOutcome {
	const saved = Object.hasOwn(stored, name) ? stored[name] : undefined;
	if (!saved) return { ok: false, error: unknownClassError(name, stored) };
	const model = env.findModel(saved.model);
	if (!model) {
		return {
			ok: false,
			error: `Model class "${name}" refers to ${saved.model}, which is no longer available. Re-save it: \`/model-class ${name} set\`.`,
		};
	}
	if (!isThinkingLevel(saved.thinking) || !supportedThinkingLevels(model).includes(saved.thinking)) {
		return {
			ok: false,
			error: `Model class "${name}" refers to ${saved.model} with thinking level "${saved.thinking}", which that model does not support. Re-save it: \`/model-class ${name} set\`.`,
		};
	}
	return { ok: true, pair: saved, origin: "stored", model };
}

/**
 * Resolve a class reference to a concrete model + thinking pair. `default`
 * snapshots the live session; a saved class name reads persisted state and
 * validates the saved combination against the current registry. Stored
 * classes return the matched registry model so callers never have to look
 * the model up a second time (a second lookup is a race window with a
 * misleading failure mode). Anything else fails closed listing the saved
 * class names.
 */
export function resolveModelClass(ref: string, stored: StoredClasses, env: ModelClassEnv): ResolveOutcome {
	if (ref === "default") {
		const pair = env.currentPair();
		if (!pair) return { ok: false, error: "no model resolved in the current session" };
		return { ok: true, pair, origin: "session" };
	}
	return resolveStoredClass(ref, stored, env);
}

/**
 * Resolve the concrete pair for one spawn (SPEC R3 — one matrix for both
 * spawn modes; the mode only selects the routing default):
 *
 * 1. explicit `requested`: `"default"` → live session pair; a saved class
 *    name → its stored pair, validated; anything else → fail closed with
 *    the saved class names listed;
 * 2. omitted: routing entry for `mode` → that entry's value, resolved as a
 *    SAVED CLASS ONLY and validated identically (an unresolvable route —
 *    dead class, invalid name, even a hand-edited `"default"` — fails closed
 *    naming the class, the mode, and the fix); no routing entry → live
 *    session pair.
 */
export function resolveSpawnTarget(
	mode: SpawnMode,
	requested: string | undefined,
	stored: StoredClasses,
	routing: RoutingTable,
	env: ModelClassEnv,
): ResolveOutcome {
	if (requested !== undefined) return resolveModelClass(requested, stored, env);
	const routed = routing[mode];
	if (routed !== undefined) {
		const outcome = resolveStoredClass(routed, stored, env);
		if (!outcome.ok) return { ok: false, error: routingFailureError(mode, routed, outcome.error) };
		return { ...outcome, route: { mode, className: routed } };
	}
	return resolveModelClass("default", stored, env);
}

// ------------------------------------------------------------------ cycling

/** Outcome of the stateless next-class selection (SPEC R5). */
export type NextClassOutcome =
	| { ok: true; name: string; pair: ModelPair }
	| { ok: false; error: string };

function samePair(a: ModelPair, b: ModelPair): boolean {
	return a.model === b.model && a.thinking === b.thinking;
}

/**
 * Stateless forward cycling: if the live session pair equals a saved
 * class's pair (model AND thinking), switch to the NEXT class in storage
 * order (wrap around); if it equals none, switch to the FIRST class; zero
 * saved classes → error, nothing changes. No "active class" is persisted —
 * the live model is the only source of truth.
 */
export function nextModelClass(current: ModelPair | null, stored: StoredClasses): NextClassOutcome {
	const names = Object.keys(stored);
	if (names.length === 0) {
		return {
			ok: false,
			error: "No saved model classes to cycle. Save one first: `/model-class <class> set`.",
		};
	}
	const matchIndex = current ? names.findIndex((n) => samePair(stored[n]!, current)) : -1;
	const name = matchIndex === -1 ? names[0]! : names[(matchIndex + 1) % names.length]!;
	return { ok: true, name, pair: stored[name]! };
}

// ------------------------------------------------------------------ switching

/** Pi-bound session mutation surface (implemented over pi / ctx). */
export interface SessionModelApplier {
	/**
	 * Apply the model of a pair. Returns `false` when the model could not be
	 * applied (e.g. no configured auth) and the session was left unchanged.
	 * May change the thinking level as a side effect (pi reselects it on a
	 * model switch) — callers must always (re)apply the thinking level after.
	 */
	setModel(pair: ModelPair, model: ModelLike): Promise<boolean>;
	/** Set the thinking level (pi clamps to the model's capabilities). */
	setThinkingLevel(level: ThinkingLevel): void;
	/** Effective thinking level after any change. */
	getThinkingLevel(): ThinkingLevel;
}

export type ApplyOutcome =
	| { ok: true }
	// `restored` is true when the previous pair was successfully re-applied,
	// false when restoration itself failed (or there was nothing to restore).
	| { ok: false; error: string; restored: boolean };

/**
 * Apply a resolved pair to the live session without ever leaving it in a
 * mixed state:
 *
 * 1. the caller must fully validate the target BEFORE calling this;
 * 2. apply the model — a `false` here means nothing changed at all;
 * 3. apply the stored thinking level;
 * 4. verify the effective thinking level; on mismatch (unexpected clamp)
 *    restore the previous model + thinking and report the error.
 */
export async function applyResolvedPair(
	applier: SessionModelApplier,
	target: { pair: ModelPair; model: ModelLike },
	previous: { pair: ModelPair; model: ModelLike } | null,
): Promise<ApplyOutcome> {
	const modelApplied = await applier.setModel(target.pair, target.model);
	if (!modelApplied) {
		return {
			ok: false,
			error: `Cannot switch: authentication is not configured for ${target.pair.model}. Session unchanged.`,
			restored: false,
		};
	}
	applier.setThinkingLevel(target.pair.thinking);
	if (applier.getThinkingLevel() === target.pair.thinking) return { ok: true };
	// The stored combination was validated, so a mismatch means pi clamped
	// for an unforeseen reason. Never keep the mixed state: restore first,
	// then report.
	let restored = false;
	if (previous) {
		try {
			if (await applier.setModel(previous.pair, previous.model)) {
				applier.setThinkingLevel(previous.pair.thinking);
				restored = applier.getThinkingLevel() === previous.pair.thinking;
			}
		} catch {
			restored = false;
		}
	}
	return {
		ok: false,
		error: `Cannot switch to ${target.pair.model} with thinking "${target.pair.thinking}": the combination was rejected. ${restored ? "Previous model restored." : "Automatic restore failed; restore the model manually."}`,
		restored,
	};
}
