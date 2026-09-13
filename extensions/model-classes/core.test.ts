/**
 * Unit tests for model class resolution and switching (SPEC §5, §8, §10):
 * dynamic `default`, stored classes, missing class/model/level, no
 * fallback, no partial switch.
 */
import { describe, expect, test } from "bun:test";
import {
	applyResolvedPair,
	canonicalModelId,
	createExactModelMatcher,
	notConfiguredError,
	resolveModelClass,
	supportedThinkingLevels,
	type ModelLike,
	type SessionModelApplier,
} from "./core";
import { THINKING_LEVELS, type ModelPair, type StoredClasses, type ThinkingLevel } from "./store";

const MODEL_A: ModelLike = {
	provider: "prov-a",
	id: "model-a",
	reasoning: true,
	thinkingLevelMap: { xhigh: "xh", max: "mx" }, // GPT-5.6-style: exposes xhigh + max
};
const MODEL_PLAIN: ModelLike = { provider: "prov-p", id: "plain", reasoning: true }; // no map: no xhigh/max
const MODEL_B: ModelLike = {
	provider: "prov-b",
	id: "openai/gpt-oss-120b", // id contains slashes (provider-hosted style)
	reasoning: true,
	thinkingLevelMap: { off: "off", medium: "m", high: "h" }, // no xhigh/max, minimal/low excluded
};
const MODEL_C: ModelLike = { provider: "prov-c", id: "text-only", reasoning: false };

// ------------------------------------------------- supportedThinkingLevels

describe("supportedThinkingLevels (mirrors pi-ai getSupportedThinkingLevels)", () => {
	test("non-reasoning models only support off", () => {
		expect(supportedThinkingLevels(MODEL_C)).toEqual(["off"]);
	});

	test("reasoning models support all levels except map-restricted ones", () => {
		expect(supportedThinkingLevels(MODEL_A)).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});

	test("without a map, xhigh/max are not exposed (pi exposes them only when supported)", () => {
		expect(supportedThinkingLevels(MODEL_PLAIN)).toEqual(["off", "minimal", "low", "medium", "high"]);
	});

	test("thinkingLevelMap: null excludes a level entirely", () => {
		const m: ModelLike = {
			provider: "prov-n",
			id: "no-minimal",
			reasoning: true,
			thinkingLevelMap: { off: "o", minimal: null, medium: "m", xhigh: "xh", max: "mx" },
		};
		expect(supportedThinkingLevels(m)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
	});

	test("thinkingLevelMap: xhigh/max require an explicit entry; listed ones stay", () => {
		expect(supportedThinkingLevels(MODEL_B)).toEqual(["off", "minimal", "low", "medium", "high"]);
	});
});

// ------------------------------------------------------- canonical + matcher

describe("createExactModelMatcher", () => {
	const matcher = createExactModelMatcher([MODEL_A, MODEL_B, MODEL_C]);

	test("canonical provider/id round-trip wins (ids may contain slashes)", () => {
		expect(matcher("prov-b/openai/gpt-oss-120b")).toBe(MODEL_B);
		expect(matcher("PROV-A/MODEL-A")).toBe(MODEL_A); // case-insensitive
		expect(canonicalModelId(MODEL_B)).toBe("prov-b/openai/gpt-oss-120b");
	});

	test("first-slash provider/id split for canonical-style identifiers", () => {
		expect(matcher("prov-c/text-only")).toBe(MODEL_C);
	});

	test("no fuzzy fallback: unknown identifiers stay unknown", () => {
		expect(matcher("model-a")).toBeUndefined(); // bare id is not a canonical ref
		expect(matcher("prov-b/openai/gpt-oss-120c")).toBeUndefined();
		expect(matcher("prov-x/model-a")).toBeUndefined();
		expect(matcher("")).toBeUndefined();
	});
});

// ------------------------------------------------------------ resolveModelClass

function envWith(models: ModelLike[], current: ModelPair | null) {
	const matcher = createExactModelMatcher(models);
	return {
		env: { currentPair: () => current, findModel: matcher },
		matcher,
	};
}

describe("resolveModelClass — default is the live session (A9, A10)", () => {
	test("snapshots whatever the session runs at resolution time", () => {
		let current: ModelPair | null = { model: "prov-a/model-a", thinking: "high" };
		const { env } = envWith([MODEL_A], null);
		const dynamicEnv = { ...env, currentPair: () => current };
		expect(resolveModelClass("default", {}, dynamicEnv)).toEqual({
			ok: true,
			pair: { model: "prov-a/model-a", thinking: "high" },
			origin: "session",
		});
		// Main switched models: the very next resolution sees the new state,
		// no extension reload in between.
		current = { model: "prov-c/text-only", thinking: "off" };
		expect(resolveModelClass("default", {}, dynamicEnv)).toEqual({
			ok: true,
			pair: { model: "prov-c/text-only", thinking: "off" },
			origin: "session",
		});
	});

	test("no resolved model -> error, not a silent fallback", () => {
		const { env } = envWith([MODEL_A], null);
		expect(resolveModelClass("default", {}, env)).toMatchObject({ ok: false });
	});
});

describe("resolveModelClass — stored classes", () => {
	const stored: StoredClasses = {
		cheap: { model: "prov-b/openai/gpt-oss-120b", thinking: "medium" },
		smart: { model: "prov-a/model-a", thinking: "xhigh" },
	};

	test("cheap/smart resolve to the persisted pair (A3, A11)", () => {
		const { env } = envWith([MODEL_A, MODEL_B, MODEL_PLAIN], { model: "prov-a/model-a", thinking: "high" });
		expect(resolveModelClass("cheap", stored, env)).toEqual({
			ok: true,
			pair: { model: "prov-b/openai/gpt-oss-120b", thinking: "medium" },
			origin: "stored",
			model: MODEL_B, // single-resolution contract: the match travels with the outcome
		});
		expect(resolveModelClass("smart", stored, env)).toMatchObject({ ok: true, origin: "stored", model: MODEL_A });
	});

	test("unconfigured class -> spec error, session state irrelevant (A7)", () => {
		const { env } = envWith([MODEL_A], { model: "prov-a/model-a", thinking: "high" });
		const outcome = resolveModelClass("cheap", {}, env);
		expect(outcome).toMatchObject({ ok: false, error: notConfiguredError("cheap") });
		expect(outcome.ok === false && outcome.error).toContain("Use `/model-class cheap set`");
	});

	test("model gone from registry -> error, NO default fallback (A8)", () => {
		const { env } = envWith([MODEL_A], { model: "prov-a/model-a", thinking: "high" });
		const onlyCheap: StoredClasses = { cheap: stored.cheap };
		const outcome = resolveModelClass("cheap", onlyCheap, env);
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && outcome.error).toContain("no longer available");
	});

	test("thinking level unsupported by the stored model -> error, no downgrade", () => {
		const { env } = envWith([MODEL_B], null);
		const outcome = resolveModelClass("smart", { smart: { model: "prov-b/openai/gpt-oss-120b", thinking: "max" } }, env);
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && outcome.error).toContain("does not support");
		expect(outcome.ok === false && outcome.error).toContain("max");
	});

	test("equal classes are all resolvable, no dedup or warning (A5)", () => {
		const { env } = envWith([MODEL_A], { model: "prov-a/model-a", thinking: "high" });
		const same: StoredClasses = {
			cheap: { model: "prov-a/model-a", thinking: "high" },
			smart: { model: "prov-a/model-a", thinking: "high" },
		};
		expect(resolveModelClass("default", same, env)).toMatchObject({ ok: true });
		expect(resolveModelClass("cheap", same, env)).toMatchObject({ ok: true });
		expect(resolveModelClass("smart", same, env)).toMatchObject({ ok: true });
	});
});

// ------------------------------------------------------------ applyResolvedPair

/**
 * Fake applier with pi's real footgun: setModel reselects the thinking
 * level (per-model default) and setThinkingLevel silently clamps to the
 * current model's supported levels.
 */
function fakeApplier(models: Record<string, ModelLike>, opts?: { failModelFor?: string }) {
	let currentModel: ModelLike | null = null;
	let level: ThinkingLevel = "off";
	let modelApplications = 0;
	const applier: SessionModelApplier = {
		async setModel(pair) {
			const model = models[pair.model];
			if (!model) throw new Error(`unknown model object for ${pair.model}`);
			if (opts?.failModelFor === pair.model) return false; // pi: auth not configured
			modelApplications++;
			currentModel = model;
			level = supportedThinkingLevels(model).includes("high") ? "medium" : "off"; // pi resets thinking on switch
			return true;
		},
		setThinkingLevel(requested) {
			if (!currentModel) return;
			const supported = supportedThinkingLevels(currentModel);
			// pi clamp: nearest supported level, then first supported.
			const idx = THINKING_LEVELS.indexOf(requested);
			for (let i = idx; i >= 0; i--) {
				if (supported.includes(THINKING_LEVELS[i])) {
					level = THINKING_LEVELS[i];
					return;
				}
			}
			for (let i = idx + 1; i < THINKING_LEVELS.length; i++) {
				if (supported.includes(THINKING_LEVELS[i])) {
					level = THINKING_LEVELS[i];
					return;
				}
			}
		},
		getThinkingLevel: () => level,
	};
	return {
		applier,
		state: () => ({ model: currentModel ? canonicalModelId(currentModel) : null, level }),
		modelApplications: () => modelApplications,
	};
}

describe("applyResolvedPair — no partial switch (SPEC §8)", () => {
	const target: { pair: ModelPair; model: ModelLike } = {
		pair: { model: "prov-b/openai/gpt-oss-120b", thinking: "high" },
		model: MODEL_B,
	};
	const previous: { pair: ModelPair; model: ModelLike } = {
		pair: { model: "prov-a/model-a", thinking: "high" },
		model: MODEL_A,
	};

	test("success applies model + stored thinking together (A3)", async () => {
		const f = fakeApplier({ "prov-b/openai/gpt-oss-120b": MODEL_B });
		const outcome = await applyResolvedPair(f.applier, target, null);
		expect(outcome).toEqual({ ok: true });
		expect(f.state()).toEqual({ model: "prov-b/openai/gpt-oss-120b", level: "high" });
	});

	test("setModel refusing (auth) changes nothing at all", async () => {
		const f = fakeApplier(
			{ "prov-b/openai/gpt-oss-120b": MODEL_B },
			{ failModelFor: "prov-b/openai/gpt-oss-120b" },
		);
		const outcome = await applyResolvedPair(f.applier, target, previous);
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && outcome.error).toContain("authentication");
		expect(outcome.ok === false && outcome.restored).toBe(false);
		expect(f.modelApplications()).toBe(0); // previous model untouched
	});

	test("rejected thinking combination restores the previous pair", async () => {
		// MODEL_B does not support "max": a validation bypass (or a racing
		// registry change) must not leave new-model + clamped-thinking.
		const f = fakeApplier({
			"prov-b/openai/gpt-oss-120b": MODEL_B,
			"prov-a/model-a": MODEL_A,
		});
		const badTarget = { pair: { model: "prov-b/openai/gpt-oss-120b", thinking: "max" as ThinkingLevel }, model: MODEL_B };
		const outcome = await applyResolvedPair(f.applier, badTarget, previous);
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && outcome.restored).toBe(true);
		expect(f.state()).toEqual({ model: "prov-a/model-a", level: "high" }); // full restore, incl. thinking
	});

	test("restore failure is reported honestly (never a silent mixed state)", async () => {
		const f = fakeApplier({ "prov-b/openai/gpt-oss-120b": MODEL_B }); // previous model object unknown -> setModel throws
		const badTarget = { pair: { model: "prov-b/openai/gpt-oss-120b", thinking: "max" as ThinkingLevel }, model: MODEL_B };
		const outcome = await applyResolvedPair(f.applier, badTarget, previous);
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && outcome.restored).toBe(false);
		expect(outcome.ok === false && outcome.error).toContain("restore the model manually");
	});
});
