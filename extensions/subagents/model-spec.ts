/**
 * Model + thinking resolution for subagent spawns.
 *
 * A model spec is Pi's own pattern syntax `provider/id[:thinking]` (the same
 * shape `--model` and `enabledModels` use). Resolution is exact against the
 * model registry — no fuzzy matching — and validates the whole combination
 * (model exists AND the thinking level is supported by that model). There is
 * no fallback: an unresolvable spec is an error, never a different model or
 * a silently lowered reasoning level.
 *
 * Pure module: no pi imports, so bun tests can exercise it directly.
 */

/** Pi thinking levels (mirrors pi-ai `ModelThinkingLevel`). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** A concrete model + thinking pair. */
export interface ModelPair {
	/** Canonical pi model identifier: `<provider>/<modelId>`. */
	model: string;
	thinking: ThinkingLevel;
}

/** Minimal structural view of a registry model needed for validation. */
export interface ModelLike {
	provider: string;
	id: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<string, string | null>>;
}

/** True when `value` is one of the seven pi thinking levels. */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** All thinking levels a model actually supports (mirrors pi-ai `getSupportedThinkingLevels`). */
export function supportedThinkingLevels(model: ModelLike): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/** Canonical identifier for a registry model. */
export function canonicalModelId(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Exact matcher for a canonical `provider/modelId` against the catalogue:
 * a case-insensitive full match wins (this handles model ids that themselves
 * contain slashes), then an explicit first-slash provider/id split. An
 * identifier that does not exist must fail, never resolve to another model.
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

/**
 * Split `provider/id[:thinking]`. Like Pi's own pattern parser, only the
 * LAST colon-suffix is treated as thinking, and only when it is a valid
 * level — model ids may themselves contain colons (`ollama/qwen3:8b`).
 */
export function splitModelSpec(spec: string): { model: string; thinking?: ThinkingLevel } {
	const trimmed = spec.trim();
	const colon = trimmed.lastIndexOf(":");
	if (colon > 0) {
		const suffix = trimmed.slice(colon + 1);
		if (isThinkingLevel(suffix)) return { model: trimmed.slice(0, colon), thinking: suffix };
	}
	return { model: trimmed };
}

/** Environment the resolver needs. */
export interface ModelSpecEnv {
	/** Registry lookup for a canonical `<provider>/<modelId>`. */
	findModel(model: string): ModelLike | undefined;
	/** Thinking level used when the spec omits one (the parent's current level). */
	defaultThinking: ThinkingLevel;
}

export type ResolveSpecOutcome =
	| { ok: true; pair: ModelPair; model: ModelLike }
	| { ok: false; error: string };

/**
 * Resolve `provider/id[:thinking]` to a validated pair. An omitted thinking
 * level takes `env.defaultThinking` and is validated the same way, so a
 * parent running at a level the target model lacks fails closed instead of
 * being clamped.
 */
export function resolveModelSpec(spec: string, env: ModelSpecEnv): ResolveSpecOutcome {
	const { model: ref, thinking } = splitModelSpec(spec);
	if (ref === "" || !ref.includes("/")) {
		return {
			ok: false,
			error: `Model "${spec}" is not a valid model reference; use \`provider/id[:thinking]\` (thinking: ${THINKING_LEVELS.join("|")}).`,
		};
	}
	const found = env.findModel(ref);
	if (!found) {
		return { ok: false, error: `Model "${ref}" is not available in the model registry (exact \`provider/id\` match required).` };
	}
	const level = thinking ?? env.defaultThinking;
	const supported = supportedThinkingLevels(found);
	if (!supported.includes(level)) {
		return {
			ok: false,
			error:
				`Model ${canonicalModelId(found)} does not support thinking level "${level}"` +
				`${thinking ? "" : " (the parent's current level)"}. Supported: ${supported.join(", ")}. ` +
				`Pass an explicit level, e.g. \`${canonicalModelId(found)}:${supported[supported.length - 1]}\`.`,
		};
	}
	return { ok: true, pair: { model: canonicalModelId(found), thinking: level }, model: found };
}
