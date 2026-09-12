/**
 * Model class resolution — the single mechanism behind `/model-class` and
 * `subagent(modelClass=...)`.
 *
 * Semantics (SPEC §2, §5):
 *
 *   default -> snapshot of the CURRENT main session model + thinking, read
 *              at resolution time (never cached at startup);
 *   cheap   -> persisted cheap configuration;
 *   smart   -> persisted smart configuration.
 *
 * `default` is not a profile: it is whatever Pi is running right now. After
 * a successful switch to `cheap`/`smart` the applied pair automatically IS
 * the new `default`; there is no notion of an "active class".
 *
 * Resolution validates the whole target combination (model exists in the
 * registry AND the stored thinking level is supported by that model) before
 * anything is applied. There is no fallback: not to `default`, not to
 * another provider/model, and no automatic reasoning downgrade.
 *
 * Pure module: no pi imports — Pi-bound callers supply the environment.
 */
import type { ModelClassRef, ModelPair, StoredClasses, ThinkingLevel } from "./store";
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
	| { ok: true; pair: ModelPair; /** Which stored state produced the pair. */ origin: "session" | "stored" }
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

/** Error text for activating a class that was never configured (SPEC §8). */
export function notConfiguredError(name: "cheap" | "smart"): string {
	return `Model class "${name}" is not configured.\nUse \`/model-class ${name} set\` to save the current model.`;
}

/**
 * Resolve a class reference to a concrete model + thinking pair (SPEC §5).
 * `default` snapshots the live session; `cheap`/`smart` read persisted state
 * and validate the saved combination against the current registry.
 */
export function resolveModelClass(ref: ModelClassRef, stored: StoredClasses, env: ModelClassEnv): ResolveOutcome {
	if (ref === "default") {
		const pair = env.currentPair();
		if (!pair) return { ok: false, error: "no model resolved in the current session" };
		return { ok: true, pair, origin: "session" };
	}
	const saved = stored[ref];
	if (!saved) return { ok: false, error: notConfiguredError(ref) };
	const model = env.findModel(saved.model);
	if (!model) {
		return {
			ok: false,
			error: `Model class "${ref}" refers to ${saved.model}, which is no longer available. Re-save it: \`/model-class ${ref} set\`.`,
		};
	}
	if (!isThinkingLevel(saved.thinking) || !supportedThinkingLevels(model).includes(saved.thinking)) {
		return {
			ok: false,
			error: `Model class "${ref}" refers to ${saved.model} with thinking level "${saved.thinking}", which that model does not support. Re-save it: \`/model-class ${ref} set\`.`,
		};
	}
	return { ok: true, pair: saved, origin: "stored" };
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
 * mixed state (SPEC §8, "Частичное переключение"):
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
