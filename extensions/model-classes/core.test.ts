/**
 * Unit tests for model class resolution and switching: dynamic `default`,
 * named stored classes, the full R3 spawn-routing matrix (explicit/omitted
 * per mode, every fail-closed path), the stateless next-class selection,
 * no fallback, no partial switch.
 */
import { describe, expect, test } from "bun:test";
import {
	applyResolvedPair,
	canonicalModelId,
	createExactModelMatcher,
	nextModelClass,
	resolveModelClass,
	resolveSpawnTarget,
	routingFailureError,
	supportedThinkingLevels,
	unknownClassError,
	type ModelClassEnv,
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
		env: { currentPair: () => current, findModel: matcher } satisfies ModelClassEnv,
		matcher,
	};
}

describe("resolveModelClass — default is the live session", () => {
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

describe("resolveModelClass — named stored classes", () => {
	const stored: StoredClasses = {
		workhorse: { model: "prov-b/openai/gpt-oss-120b", thinking: "medium" },
		heavy: { model: "prov-a/model-a", thinking: "xhigh" },
	};

	test("saved classes resolve to the persisted pair", () => {
		const { env } = envWith([MODEL_A, MODEL_B, MODEL_PLAIN], { model: "prov-a/model-a", thinking: "high" });
		expect(resolveModelClass("workhorse", stored, env)).toEqual({
			ok: true,
			pair: { model: "prov-b/openai/gpt-oss-120b", thinking: "medium" },
			origin: "stored",
			model: MODEL_B, // single-resolution contract: the match travels with the outcome
			route: undefined,
		});
		expect(resolveModelClass("heavy", stored, env)).toMatchObject({ ok: true, origin: "stored", model: MODEL_A });
	});

	test("old cheap/smart names keep working as ordinary classes (compat)", () => {
		const legacy: StoredClasses = {
			cheap: { model: "prov-b/openai/gpt-oss-120b", thinking: "medium" },
			smart: { model: "prov-a/model-a", thinking: "xhigh" },
		};
		const { env } = envWith([MODEL_A, MODEL_B], null);
		expect(resolveModelClass("cheap", legacy, env)).toMatchObject({ ok: true, origin: "stored" });
		expect(resolveModelClass("smart", legacy, env)).toMatchObject({ ok: true, origin: "stored" });
	});

	test("unknown class -> fail closed with the saved class names listed (R3)", () => {
		const { env } = envWith([MODEL_A], { model: "prov-a/model-a", thinking: "high" });
		const outcome = resolveModelClass("budget", stored, env);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.error).toBe(unknownClassError("budget", stored));
		expect(outcome.error).toContain("workhorse, heavy");
		expect(outcome.error).toContain("`/model-class budget set`");
	});

	test("unknown class with zero saved classes names that honestly", () => {
		const { env } = envWith([MODEL_A], null);
		const outcome = resolveModelClass("anything", {}, env);
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && outcome.error).toContain("none are saved yet");
	});

	test("model gone from registry -> error, NO default fallback", () => {
		const { env } = envWith([MODEL_A], { model: "prov-a/model-a", thinking: "high" });
		const onlyWorkhorse: StoredClasses = { workhorse: stored.workhorse };
		const outcome = resolveModelClass("workhorse", onlyWorkhorse, env);
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && outcome.error).toContain("no longer available");
		expect(outcome.ok === false && outcome.error).toContain("Re-save it: `/model-class workhorse set`");
	});

	test("thinking level unsupported by the stored model -> error, no downgrade", () => {
		const { env } = envWith([MODEL_B], null);
		const outcome = resolveModelClass(
			"heavy",
			{ heavy: { model: "prov-b/openai/gpt-oss-120b", thinking: "max" } },
			env,
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && outcome.error).toContain("does not support");
		expect(outcome.ok === false && outcome.error).toContain("max");
	});

	test("equal classes are all resolvable, no dedup or warning", () => {
		const { env } = envWith([MODEL_A], { model: "prov-a/model-a", thinking: "high" });
		const same: StoredClasses = {
			workhorse: { model: "prov-a/model-a", thinking: "high" },
			heavy: { model: "prov-a/model-a", thinking: "high" },
		};
		expect(resolveModelClass("default", same, env)).toMatchObject({ ok: true });
		expect(resolveModelClass("workhorse", same, env)).toMatchObject({ ok: true });
		expect(resolveModelClass("heavy", same, env)).toMatchObject({ ok: true });
	});
});

// ------------------------------------------------------- resolveSpawnTarget

describe("resolveSpawnTarget — the R3 matrix", () => {
	const stored: StoredClasses = {
		workhorse: { model: "prov-b/openai/gpt-oss-120b", thinking: "medium" },
		heavy: { model: "prov-a/model-a", thinking: "xhigh" },
	};
	const session: ModelPair = { model: "prov-c/text-only", thinking: "off" };
	function env(sessionPair: ModelPair | null) {
		return envWith([MODEL_A, MODEL_B, MODEL_C], sessionPair).env;
	}

	test("1a. explicit \"default\" -> live session pair, even with routing configured (A5)", () => {
		const routing = { plain: "workhorse" as const, repoOwner: "heavy" as const };
		for (const mode of ["plain", "repoOwner"] as const) {
			expect(resolveSpawnTarget(mode, "default", stored, routing, env(session))).toEqual({
				ok: true,
				pair: session,
				origin: "session",
			});
		}
	});

	test("1b. explicit saved class -> its stored pair, validated (A4)", () => {
		expect(resolveSpawnTarget("plain", "heavy", stored, {}, env(session))).toMatchObject({
			ok: true,
			pair: { model: "prov-a/model-a", thinking: "xhigh" },
			origin: "stored",
			model: MODEL_A,
		});
		// explicit override ignores the mode's routing
		expect(resolveSpawnTarget("repoOwner", "workhorse", stored, { repoOwner: "heavy" }, env(session))).toMatchObject(
			{ ok: true, pair: stored.workhorse, origin: "stored" },
		);
	});

	test("1c. explicit unknown -> fail closed listing saved names", () => {
		const outcome = resolveSpawnTarget("plain", "nosuch", stored, { plain: "workhorse" }, env(session));
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && outcome.error).toContain("workhorse, heavy");
	});

	test("1d. explicit dead model -> fail closed with the re-save hint", () => {
		const dead: StoredClasses = { gone: { model: "prov-x/vanished", thinking: "high" } };
		const outcome = resolveSpawnTarget("plain", "gone", dead, {}, env(session));
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && outcome.error).toContain("no longer available");
	});

	test("2a. omitted + route for the mode -> that class's pair (A2/A3)", () => {
		expect(resolveSpawnTarget("plain", undefined, stored, { plain: "workhorse" }, env(session))).toMatchObject({
			ok: true,
			pair: stored.workhorse,
			origin: "stored",
			route: { mode: "plain", className: "workhorse" },
		});
		expect(
			resolveSpawnTarget("repoOwner", undefined, stored, { repoOwner: "heavy" }, env(session)),
		).toMatchObject({ ok: true, pair: stored.heavy, origin: "stored" });
	});

	test("2b. routing applies BY MODE: an unrouted mode inherits the session (R3)", () => {
		expect(resolveSpawnTarget("repoOwner", undefined, stored, { plain: "workhorse" }, env(session))).toEqual({
			ok: true,
			pair: session,
			origin: "session",
		});
		expect(resolveSpawnTarget("plain", undefined, stored, { repoOwner: "heavy" }, env(session))).toEqual({
			ok: true,
			pair: session,
			origin: "session",
		});
	});

	test("2c. omitted + no routing at all -> live session pair (migration, A1)", () => {
		expect(resolveSpawnTarget("plain", undefined, stored, {}, env(session))).toEqual({
			ok: true,
			pair: session,
			origin: "session",
		});
		expect(resolveSpawnTarget("repoOwner", undefined, stored, {}, env(session))).toEqual({
			ok: true,
			pair: session,
			origin: "session",
		});
	});

	test("2d. omitted + no routing + no session model -> fail closed", () => {
		const outcome = resolveSpawnTarget("plain", undefined, stored, {}, env(null));
		expect(outcome).toMatchObject({ ok: false, error: "no model resolved in the current session" });
	});

	test("2e. route to a missing class -> fail closed naming class, mode, and fix (A6, D4)", () => {
		const outcome = resolveSpawnTarget(
			"repoOwner",
			undefined,
			stored,
			{ repoOwner: "nosuch" },
			env(session),
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.error).toBe(routingFailureError("repoOwner", "nosuch", unknownClassError("nosuch", stored)));
		expect(outcome.error).toContain('"repoOwner"');
		expect(outcome.error).toContain('"nosuch"');
		expect(outcome.error).toContain("/model-class route repoOwner <class|inherit>");
		expect(outcome.error).toContain("/model-class nosuch set");
	});

	test("2f. route to a dead model -> same failure shape at spawn time (A7)", () => {
		const dead: StoredClasses = { workhorse: { model: "prov-gone/vanished", thinking: "high" } };
		const outcome = resolveSpawnTarget("plain", undefined, dead, { plain: "workhorse" }, env(session));
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.error).toContain("Spawn routing for mode \"plain\" is set to class \"workhorse\"");
		expect(outcome.error).toContain("no longer available");
		expect(outcome.error).toContain("/model-class route plain <class|inherit>");
	});

	test("2g. route to an unsupported thinking combination -> fail closed", () => {
		const bad: StoredClasses = { heavy: { model: "prov-b/openai/gpt-oss-120b", thinking: "max" } };
		const outcome = resolveSpawnTarget("repoOwner", undefined, bad, { repoOwner: "heavy" }, env(session));
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && outcome.error).toContain("does not support");
	});
});

// ---------------------------------------------------------- nextModelClass

describe("nextModelClass — stateless cycle (R5, A9)", () => {
	const stored: StoredClasses = {
		workhorse: { model: "prov-b/openai/gpt-oss-120b", thinking: "medium" },
		heavy: { model: "prov-a/model-a", thinking: "xhigh" },
	};

	test("session on the LAST class wraps to the first", () => {
		expect(nextModelClass(stored.heavy, stored)).toEqual({ ok: true, name: "workhorse", pair: stored.workhorse });
	});

	test("session on a class -> the NEXT class in storage order", () => {
		expect(nextModelClass(stored.workhorse, stored)).toEqual({ ok: true, name: "heavy", pair: stored.heavy });
	});

	test("session pair matches NO class -> the FIRST class", () => {
		expect(nextModelClass({ model: "prov-c/text-only", thinking: "off" }, stored)).toEqual({
			ok: true,
			name: "workhorse",
			pair: stored.workhorse,
		});
		expect(nextModelClass(null, stored)).toEqual({ ok: true, name: "workhorse", pair: stored.workhorse });
	});

	test("pair equality requires model AND thinking", () => {
		const nearMiss: ModelPair = { model: "prov-a/model-a", thinking: "high" }; // same model, other thinking
		expect(nextModelClass(nearMiss, stored)).toEqual({ ok: true, name: "workhorse", pair: stored.workhorse });
	});

	test("first of duplicate pairs matches; next skips to the following class", () => {
		const dupes: StoredClasses = {
			a: { model: "prov-a/model-a", thinking: "high" },
			b: { model: "prov-a/model-a", thinking: "high" },
			c: { model: "prov-b/openai/gpt-oss-120b", thinking: "medium" },
		};
		expect(nextModelClass(dupes.a, dupes).name).toBe("b");
		expect(nextModelClass(dupes.c, dupes).name).toBe("a");
	});

	test("zero classes -> informative error, nothing changes", () => {
		const outcome = nextModelClass({ model: "prov-a/model-a", thinking: "high" }, {});
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && outcome.error).toContain("No saved model classes");
		expect(outcome.ok === false && outcome.error).toContain("/model-class <class> set");
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
				if (supported.includes(THINKING_LEVELS[i]!)) {
					level = THINKING_LEVELS[i]!;
					return;
				}
			}
			for (let i = idx + 1; i < THINKING_LEVELS.length; i++) {
				if (supported.includes(THINKING_LEVELS[i]!)) {
					level = THINKING_LEVELS[i]!;
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

describe("applyResolvedPair — no partial switch", () => {
	const target: { pair: ModelPair; model: ModelLike } = {
		pair: { model: "prov-b/openai/gpt-oss-120b", thinking: "high" },
		model: MODEL_B,
	};
	const previous: { pair: ModelPair; model: ModelLike } = {
		pair: { model: "prov-a/model-a", thinking: "high" },
		model: MODEL_A,
	};

	test("success applies model + stored thinking together", async () => {
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
