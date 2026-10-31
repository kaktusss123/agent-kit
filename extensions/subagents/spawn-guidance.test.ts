/**
 * Unit tests for the subagent_model_defaults guidance section: it renders
 * every fixed role with its CURRENT effective model (bound spec or
 * "session") and states the model/role usage rule. The builder is pure, so
 * "fresh" is exercised by building twice from different states.
 */
import { describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import { buildSpawnModelSection, buildSpawnModelSectionError, SPAWN_MODEL_SECTION } from "./spawn-guidance.ts";

describe("buildSpawnModelSection", () => {
	test("lists all roles; unbound roles say they use the session model", () => {
		const text = buildSpawnModelSection({ bindings: {} });
		for (const role of ["explore", "helper", "review", "owner"]) expect(text).toContain(`- ${role} (`);
		expect(text.match(/: unbound \(uses the session model\)$/gm)).toHaveLength(4);
	});

	test("bound roles render their spec and reflect changes between builds", () => {
		const first = buildSpawnModelSection({ bindings: { review: "zai/glm-max:xhigh" } });
		expect(first).toContain("- review (independent fresh-context reviewer): zai/glm-max:xhigh");
		expect(first).toContain("- explore (cheap read-only research): unbound (uses the session model)");
		const second = buildSpawnModelSection({ bindings: { review: "zai/glm-x:low", explore: "zai/cheap" } });
		expect(second).toContain("review (independent fresh-context reviewer): zai/glm-x:low");
		expect(second).toContain("explore (cheap read-only research): zai/cheap");
		expect(second).not.toContain("glm-max");
	});

	test("states the usage rule", () => {
		const text = buildSpawnModelSection({ bindings: {} });
		expect(text).toContain("If the user named a model, pass `model`");
		expect(text).toContain("`review` for independent review");
		expect(text).toContain("`explore` for cheap read-only research");
		expect(text).toContain("Do not pass `model` or `role` on owner dispatches unless the user asked for a specific model");
	});

	test("the section tag is stable", () => {
		expect(SPAWN_MODEL_SECTION).toBe("subagent_model_defaults");
	});
});

describe("buildSpawnModelSectionError", () => {
	test("says role spawns fail closed, names the cause, and keeps explicit model usable", () => {
		const text = buildSpawnModelSectionError("corrupt: /x/subagent-roles.json");
		expect(text).toContain("fail closed");
		expect(text).toContain("corrupt: /x/subagent-roles.json");
		expect(text).toContain("explicit `model` still works");
	});
});
