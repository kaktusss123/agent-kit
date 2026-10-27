/**
 * Unit tests for `provider/id[:thinking]` resolution: exact registry match,
 * thinking validation against the model's capabilities, the current-level
 * default, and fail-closed errors with no fallback.
 */
import { describe, expect, test } from "bun:test";
import {
	createExactModelMatcher,
	resolveModelSpec,
	splitModelSpec,
	supportedThinkingLevels,
	type ModelLike,
} from "./model-spec";

const PLAIN: ModelLike = { provider: "prov-a", id: "model-a" }; // non-reasoning
const REASONING: ModelLike = { provider: "prov-a", id: "model-r", reasoning: true };
const MAXED: ModelLike = {
	provider: "prov-b",
	id: "openai/gpt-oss-120b",
	reasoning: true,
	thinkingLevelMap: { xhigh: "xh", max: "mx" },
};
const COLON: ModelLike = { provider: "ollama", id: "qwen3:8b", reasoning: true };
const REGISTRY = [PLAIN, REASONING, MAXED, COLON];

const env = (defaultThinking: "off" | "low" | "high" = "low") => ({
	findModel: createExactModelMatcher(REGISTRY),
	defaultThinking,
});

describe("splitModelSpec", () => {
	test("splits a trailing valid thinking level only", () => {
		expect(splitModelSpec("p/m:high")).toEqual({ model: "p/m", thinking: "high" });
		expect(splitModelSpec("p/m")).toEqual({ model: "p/m" });
		expect(splitModelSpec("ollama/qwen3:8b")).toEqual({ model: "ollama/qwen3:8b" });
		expect(splitModelSpec("ollama/qwen3:8b:low")).toEqual({ model: "ollama/qwen3:8b", thinking: "low" });
	});
});

describe("supportedThinkingLevels", () => {
	test("non-reasoning models only support off; xhigh/max need a map entry", () => {
		expect(supportedThinkingLevels(PLAIN)).toEqual(["off"]);
		expect(supportedThinkingLevels(REASONING)).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(supportedThinkingLevels(MAXED)).toContain("max");
	});
});

describe("resolveModelSpec", () => {
	test("exact provider/id with explicit thinking", () => {
		const r = resolveModelSpec("prov-a/model-r:high", env());
		expect(r).toMatchObject({ ok: true, pair: { model: "prov-a/model-r", thinking: "high" } });
	});

	test("omitted thinking takes the current level", () => {
		const r = resolveModelSpec("prov-a/model-r", env("low"));
		expect(r).toMatchObject({ ok: true, pair: { model: "prov-a/model-r", thinking: "low" } });
	});

	test("model ids containing slashes and colons resolve exactly", () => {
		expect(resolveModelSpec("prov-b/openai/gpt-oss-120b:max", env())).toMatchObject({
			ok: true,
			pair: { model: "prov-b/openai/gpt-oss-120b", thinking: "max" },
		});
		expect(resolveModelSpec("ollama/qwen3:8b:low", env())).toMatchObject({
			ok: true,
			pair: { model: "ollama/qwen3:8b", thinking: "low" },
		});
	});

	test("unknown model fails closed (no fuzzy matching)", () => {
		for (const spec of ["prov-a/model", "model-r", "prov-a/model-r2:low", "", "nosuch/model"]) {
			expect(resolveModelSpec(spec, env()).ok, spec).toBe(false);
		}
	});

	test("unsupported explicit thinking fails and lists the supported levels", () => {
		const r = resolveModelSpec("prov-a/model-r:max", env());
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("Supported: off, minimal, low, medium, high");
	});

	test("an unsupported CURRENT level fails the same way (no clamping)", () => {
		const r = resolveModelSpec("prov-a/model-a", env("high"));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("current level");
	});
});
