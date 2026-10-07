/**
 * Unit tests for the subagent_model_defaults guidance section: it must
 * render the CURRENT saved class/model pairs and the effective
 * omitted-modelClass chain per spawn mode (routing first, repoOwner's
 * implicit heavy, then the session pair), never a stale snapshot — the
 * section builder is pure, so "fresh" is exercised by building twice from
 * different states. The soft usage rule (omit on workspace; heavy for
 * RepoOwner work; smart for review/complex reasoning) must be stated next
 * to the defaults.
 */
import { describe, expect, test } from "bun:test";
import {
	buildSpawnModelSection,
	buildSpawnModelSectionError,
	SPAWN_MODEL_SECTION,
} from "./spawn-guidance";
import type { StoredClasses } from "../model-classes/store";

const SESSION = { model: "zai/glm-x", thinking: "low" };

describe("buildSpawnModelSection", () => {
	test("saved classes render with their concrete model pairs", () => {
		const classes: StoredClasses = {
			heavy: { model: "zai/glm-max", thinking: "xhigh" },
			smart: { model: "openai-codex/gpt-6.1-sol", thinking: "medium" },
		};
		const text = buildSpawnModelSection({ classes, routing: {}, session: SESSION });
		expect(text).toContain("heavy=zai/glm-max (xhigh)");
		expect(text).toContain("smart=openai-codex/gpt-6.1-sol (medium)");
	});

	test("effective defaults: repoOwner routing first, then implicit heavy, then the session pair", () => {
		const classes: StoredClasses = { heavy: { model: "zai/glm-max", thinking: "xhigh" } };
		// no route: the saved heavy is the effective default
		const unrouted = buildSpawnModelSection({ classes, routing: {}, session: SESSION });
		expect(unrouted).toContain("workspace (repoOwner) spawn, modelClass omitted: no route, implicit heavy -> zai/glm-max (xhigh)");
		expect(unrouted).toContain("plain spawn, modelClass omitted: no route -> current session model zai/glm-x (low)");
		// a route wins over the implicit class
		const routed = buildSpawnModelSection({ classes, routing: { repoOwner: "heavy", plain: "heavy" }, session: SESSION });
		expect(routed).toContain("workspace (repoOwner) spawn, modelClass omitted: route=heavy -> zai/glm-max (xhigh)");
		expect(routed).toContain("plain spawn, modelClass omitted: route=heavy -> zai/glm-max (xhigh)");
		// no saved heavy: the session pair is the default and is said so
		const noHeavy = buildSpawnModelSection({ classes: {}, routing: {}, session: SESSION });
		expect(noHeavy).toContain("no saved heavy -> current session model zai/glm-x (low)");
		expect(noHeavy).toContain('saved classes: none (modelClass accepts only "default")');
	});

	test("a broken route is visible as failing closed, not silently re-defaulted", () => {
		const text = buildSpawnModelSection({
			classes: { heavy: { model: "zai/glm-max", thinking: "xhigh" } },
			routing: { plain: "nosuch" },
			session: SESSION,
		});
		expect(text).toContain("route=nosuch (NOT SAVED — spawns fail closed)");
	});

	test("the soft usage rule is stated next to the defaults", () => {
		const text = buildSpawnModelSection({ classes: {}, routing: {}, session: SESSION });
		expect(text).toContain("omit modelClass on workspace (RepoOwner) spawns unless the user explicitly requests another class");
		expect(text).toContain("on plain spawns you may pick a class yourself");
		expect(text).toContain("heavy is the normal RepoOwner implementation class");
		expect(text).toContain("smart suits review and complex/nontrivial reasoning");
		expect(text).toContain('"default" (the live session model) always overrides');
	});

	test("the omission rule is scoped to workspace only, never to plain spawns", () => {
		// Regression surface: the rule must restrict omission guidance to
		// workspace (RepoOwner) spawns; plain class selection (e.g. a smart
		// reviewer) stays allowed, so a blanket "omit modelClass unless the
		// user asks" phrasing must not reappear.
		const text = buildSpawnModelSection({ classes: {}, routing: {}, session: SESSION });
		expect(text.indexOf("omit modelClass on workspace")).toBeGreaterThanOrEqual(0);
		expect(text).not.toMatch(/omit modelClass unless the user/);
		expect(text).toContain("on plain spawns you may pick a class yourself — smart suits review");
	});

	test("fresh state changes the text (no stale snapshot)", () => {
		const before = buildSpawnModelSection({ classes: {}, routing: {}, session: SESSION });
		const after = buildSpawnModelSection({
			classes: { heavy: { model: "zai/glm-max", thinking: "xhigh" } },
			routing: {},
			session: SESSION,
		});
		expect(before).not.toBe(after);
		expect(SPAWN_MODEL_SECTION).toBe("subagent_model_defaults");
	});

	test("unreadable storage degrades to an explicit fail-closed note", () => {
		const text = buildSpawnModelSectionError("model classes storage is corrupt (not valid JSON): /x/y.json");
		expect(text).toContain("storage is unreadable");
		expect(text).toContain("fail closed");
		expect(text).toContain("/x/y.json");
	});
});
