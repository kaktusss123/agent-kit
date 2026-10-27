/**
 * Unit tests for the spawn-time model boundary: explicit `model`, role
 * bindings, the unbound-role session default, the mode/role validity
 * matrix, and fail-closed errors. The tool calls resolveSpawnPair
 * immediately before starting a child, so a throw here IS the no-child
 * guarantee.
 *
 * Every case runs against a throwaway PI_CODING_AGENT_DIR: nothing here may
 * depend on (or accidentally read) the real user bindings.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelLike } from "./model-spec";
import { effectiveRole, resolveSpawnPair } from "./spawn-model";

const MAIN_MODEL: ModelLike = { provider: "prov-a", id: "model-a", reasoning: true };
const BIG_MODEL: ModelLike = {
	provider: "prov-b",
	id: "openai/gpt-oss-120b",
	reasoning: true,
	thinkingLevelMap: { xhigh: "xh", max: "mx" },
};
const REGISTRY = [MAIN_MODEL, BIG_MODEL];
const SESSION = { provider: "prov-a", id: "model-a" };

function ctx(current: { provider: string; id: string } | null = SESSION) {
	return { model: current ?? undefined, modelRegistry: { getAll: () => REGISTRY } };
}

const tempDirs: string[] = [];
afterEach(() => {
	for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
/** Run with a throwaway agent dir; `stored` is a bindings object, raw string, or undefined for no file. */
function withRoles<T>(stored: Record<string, unknown> | string | undefined, run: (file: string) => T): T {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-model-test-"));
	tempDirs.push(dir);
	const file = path.join(dir, "subagent-roles.json");
	if (stored !== undefined) fs.writeFileSync(file, typeof stored === "string" ? stored : JSON.stringify(stored));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		return run(file);
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
	}
}

describe("effectiveRole", () => {
	test("workspace is always owner; plain defaults to helper; invalid combinations throw", () => {
		expect(effectiveRole("workspace", undefined)).toBe("owner");
		expect(effectiveRole("workspace", "owner")).toBe("owner");
		expect(() => effectiveRole("workspace", "review")).toThrow(/owner/);
		expect(effectiveRole("plain", undefined)).toBe("helper");
		expect(effectiveRole("plain", "review")).toBe("review");
		expect(() => effectiveRole("plain", "owner")).toThrow(/workspace/);
		expect(() => effectiveRole("plain", "fast")).toThrow(/Unknown role/);
	});
});

describe("resolveSpawnPair — explicit model", () => {
	test("resolves exactly, with and without :thinking, in both modes", () => {
		withRoles(undefined, () => {
			for (const mode of ["plain", "workspace"] as const) {
				expect(resolveSpawnPair(mode, { model: "prov-b/openai/gpt-oss-120b:xhigh" }, ctx(), "low")).toEqual({
					model: "prov-b/openai/gpt-oss-120b",
					thinking: "xhigh",
				});
				expect(resolveSpawnPair(mode, { model: "prov-b/openai/gpt-oss-120b" }, ctx(), "high")).toEqual({
					model: "prov-b/openai/gpt-oss-120b",
					thinking: "high",
				});
			}
		});
	});

	test("unknown model and unsupported thinking throw; there is no fallback", () => {
		withRoles({ helper: "prov-a/model-a:low" }, () => {
			expect(() => resolveSpawnPair("plain", { model: "prov-x/none" }, ctx(), "low")).toThrow(/not available/);
			expect(() => resolveSpawnPair("plain", { model: "prov-a/model-a:max" }, ctx(), "low")).toThrow(/does not support/);
		});
	});

	test("does not read the bindings file (a corrupt file cannot break an explicit model)", () => {
		withRoles("{ nope", () => {
			expect(resolveSpawnPair("plain", { model: "prov-a/model-a:low" }, ctx(), "high").model).toBe("prov-a/model-a");
		});
	});

	test("model and role together throw before anything resolves", () => {
		withRoles(undefined, () => {
			expect(() => resolveSpawnPair("plain", { model: "prov-a/model-a", role: "review" }, ctx(), "low")).toThrow(/mutually exclusive/);
			expect(() => resolveSpawnPair("workspace", { model: "prov-a/model-a", role: "owner" }, ctx(), "low")).toThrow(/mutually exclusive/);
		});
	});
});

describe("resolveSpawnPair — roles", () => {
	test("a bound role uses its binding; thinking defaults to the current level when unspecified", () => {
		withRoles({ review: "prov-b/openai/gpt-oss-120b:max", explore: "prov-a/model-a" }, () => {
			expect(resolveSpawnPair("plain", { role: "review" }, ctx(), "low")).toEqual({
				model: "prov-b/openai/gpt-oss-120b",
				thinking: "max",
			});
			expect(resolveSpawnPair("plain", { role: "explore" }, ctx(), "medium")).toEqual({
				model: "prov-a/model-a",
				thinking: "medium",
			});
		});
	});

	test("an unbound role (and an absent file) resolves to the session model + current thinking", () => {
		withRoles(undefined, () => {
			expect(resolveSpawnPair("plain", { role: "review" }, ctx(), "high")).toEqual({ model: "prov-a/model-a", thinking: "high" });
			expect(resolveSpawnPair("plain", {}, ctx(), "low")).toEqual({ model: "prov-a/model-a", thinking: "low" });
			expect(resolveSpawnPair("workspace", {}, ctx(), "low")).toEqual({ model: "prov-a/model-a", thinking: "low" });
		});
	});

	test("plain without role uses the helper binding; workspace without params uses the owner binding", () => {
		withRoles({ helper: "prov-a/model-a:minimal", owner: "prov-b/openai/gpt-oss-120b:xhigh", review: "prov-a/model-a:off" }, () => {
			expect(resolveSpawnPair("plain", {}, ctx(), "high").thinking).toBe("minimal");
			expect(resolveSpawnPair("workspace", {}, ctx(), "low")).toEqual({
				model: "prov-b/openai/gpt-oss-120b",
				thinking: "xhigh",
			});
		});
	});

	test("an unbound role with no session model throws", () => {
		withRoles(undefined, () => {
			expect(() => resolveSpawnPair("plain", {}, ctx(null), "low")).toThrow(/no model resolved/);
		});
	});

	test("a broken binding fails closed naming the file, the role, and the fix", () => {
		withRoles({ review: "gone/vanished:high" }, (file) => {
			let message = "";
			try {
				resolveSpawnPair("plain", { role: "review" }, ctx(), "low");
			} catch (e) {
				message = (e as Error).message;
			}
			expect(message).toContain(file);
			expect(message).toContain('"review"');
			expect(message).toContain("/subagent-role review");
		});
		withRoles({ review: "prov-a/model-a:max" }, () => {
			expect(() => resolveSpawnPair("plain", { role: "review" }, ctx(), "low")).toThrow(/does not support/);
		});
	});

	test("corrupt JSON, an unknown key, and an unreadable path all fail closed — even for roles with no entry", () => {
		withRoles("{ nope", (file) => {
			expect(() => resolveSpawnPair("plain", {}, ctx(), "low")).toThrow(file);
		});
		withRoles({ fast: "prov-a/model-a" }, (file) => {
			expect(() => resolveSpawnPair("workspace", {}, ctx(), "low")).toThrow(file);
		});
		withRoles(undefined, (file) => {
			fs.mkdirSync(file); // a directory where the file should be → read error, not "absent"
			expect(() => resolveSpawnPair("plain", {}, ctx(), "low")).toThrow(file);
		});
	});

	test("bindings are read fresh on every call", () => {
		withRoles({ review: "prov-a/model-a:low" }, (file) => {
			expect(resolveSpawnPair("plain", { role: "review" }, ctx(), "high").thinking).toBe("low");
			fs.writeFileSync(file, JSON.stringify({ review: "prov-a/model-a:high" }));
			expect(resolveSpawnPair("plain", { role: "review" }, ctx(), "off").thinking).toBe("high");
		});
	});
});
