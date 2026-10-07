/**
 * Unit tests for the subagent spawn modelClass boundary (SPEC R3): the
 * literal `default` and omitted-with-no-storage resolve the live session
 * pair without ever consulting stored classes, explicit and routed classes
 * resolve persisted state through the registry, routing is per spawn mode,
 * and an unresolvable or unreadable target throws here — the tool calls
 * this immediately before `runtime.spawn()`, so a throw here IS the
 * no-child guarantee (fail closed, no fallback). An omitted param with
 * unreadable (corrupt) storage also fails closed: routing state is
 * unknown, not absent (D4).
 *
 * Every case runs against a throwaway PI_CODING_AGENT_DIR: nothing here may
 * depend on (or accidentally read) the real user storage.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelLike } from "../model-classes/core";
import { resolveSpawnPair } from "./spawn-model";

const MAIN_MODEL: ModelLike = { provider: "prov-a", id: "model-a", reasoning: true };
const HEAVY_MODEL: ModelLike = {
	provider: "prov-b",
	id: "openai/gpt-oss-120b",
	reasoning: true,
	thinkingLevelMap: { xhigh: "xh", max: "mx" }, // GPT-5.6-style: exposes xhigh + max
};

function ctx(current: { provider: string; id: string } | null, models: ModelLike[]) {
	return {
		model: current ?? undefined,
		modelRegistry: { getAll: () => models },
	};
}

const SESSION = { provider: "prov-a", id: "model-a" };

// Storage fixture: a throwaway PI_CODING_AGENT_DIR per case. `stored` is
// either a raw JSON object payload (classes and/or routing), a raw string
// payload (e.g. deliberately corrupt content), or undefined for NO storage
// file.
const tempDirs: string[] = [];
function spawnStorageDir(stored?: Record<string, unknown> | string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-model-test-"));
	tempDirs.push(dir);
	if (stored !== undefined) {
		const payload = typeof stored === "string" ? stored : JSON.stringify(stored);
		fs.writeFileSync(path.join(dir, "model-classes.json"), payload);
	}
	return dir;
}
function withAgentDir<T>(
	stored: Record<string, unknown> | string | undefined,
	run: (dir: string) => T,
): T {
	const prev = process.env.PI_CODING_AGENT_DIR;
	const dir = spawnStorageDir(stored);
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		return run(dir);
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Deliberately corrupt storage payload (default-independence fixture). */
const CORRUPT = "{ not json";

const STORED_HEAVY = { model: "prov-b/openai/gpt-oss-120b", thinking: "xhigh" as const };
const REGISTRY = [MAIN_MODEL, HEAVY_MODEL];

describe("resolveSpawnPair — the literal default / inheritance paths", () => {
	test("\"default\" snapshots the current Main model + thinking", () => {
		withAgentDir({ heavy: STORED_HEAVY }, () => {
			const pair = resolveSpawnPair("plain", "default", ctx(SESSION, REGISTRY), "high");
			expect(pair).toEqual({ model: "prov-a/model-a", thinking: "high" });
		});
		// Main switched since: the next spawn gets the new state, not a cache.
		withAgentDir({ heavy: STORED_HEAVY }, () => {
			const switched = resolveSpawnPair(
				"plain",
				"default",
				ctx({ provider: "prov-b", id: "openai/gpt-oss-120b" }, REGISTRY),
				"medium",
			);
			expect(switched).toEqual({ model: "prov-b/openai/gpt-oss-120b", thinking: "medium" });
		});
	});

	test("\"default\" works with missing storage", () => {
		withAgentDir(undefined, () => {
			const pair = resolveSpawnPair("plain", "default", ctx(SESSION, REGISTRY), "high");
			expect(pair).toEqual({ model: "prov-a/model-a", thinking: "high" });
		});
	});

	test("\"default\" works with corrupt storage", () => {
		withAgentDir(CORRUPT, () => {
			const pair = resolveSpawnPair("plain", "default", ctx(SESSION, REGISTRY), "high");
			expect(pair).toEqual({ model: "prov-a/model-a", thinking: "high" });
		});
	});

	test("omitted with no routing configured inherits the session pair (migration, A1)", () => {
		withAgentDir({ cheap: { model: "prov-a/model-a", thinking: "low" } }, () => {
			for (const mode of ["plain", "repoOwner"] as const) {
				expect(resolveSpawnPair(mode, undefined, ctx(SESSION, REGISTRY), "medium")).toEqual({
					model: "prov-a/model-a",
					thinking: "medium",
				});
			}
		});
	});

	test("omitted with missing storage inherits the session pair", () => {
		withAgentDir(undefined, () => {
			expect(resolveSpawnPair("plain", undefined, ctx(SESSION, REGISTRY), "low")).toEqual({
				model: "prov-a/model-a",
				thinking: "low",
			});
		});
	});

	test("omitted with an empty or whitespace-only storage file inherits the session pair (empty ≡ missing)", () => {
		for (const payload of ["", "  \n\t"]) {
			withAgentDir(payload, () => {
				for (const mode of ["plain", "repoOwner"] as const) {
					expect(resolveSpawnPair(mode, undefined, ctx(SESSION, REGISTRY), "medium")).toEqual({
						model: "prov-a/model-a",
						thinking: "medium",
					});
				}
			});
		}
	});

	test("an explicit class with an empty storage file still fails as unknown class", () => {
		withAgentDir("", () => {
			expect(() => resolveSpawnPair("plain", "heavy", ctx(SESSION, REGISTRY), "high")).toThrow(
				/Model class "heavy" is not saved/,
			);
		});
	});

	test("omitted with corrupt storage fails closed: routing state is unknown, not absent (D4)", () => {
		withAgentDir(CORRUPT, (dir) => {
			for (const mode of ["plain", "repoOwner"] as const) {
				let message: string | undefined;
				try {
					resolveSpawnPair(mode, undefined, ctx(SESSION, REGISTRY), "low");
				} catch (e) {
					message = e instanceof Error ? e.message : String(e);
				}
				// actionable: names the corruption, the file path, and the fix
				expect(message).toContain("corrupt");
				expect(message).toContain(path.join(dir, "model-classes.json"));
				expect(message).toContain("valid JSON");
				expect(message).toContain("/model-class route <mode> <class|inherit>");
			}
		});
	});

	test("default with no resolved session model throws instead of guessing", () => {
		withAgentDir(CORRUPT, () => {
			expect(() => resolveSpawnPair("plain", "default", ctx(null, REGISTRY), "high")).toThrow(
				/no model resolved in the current session/,
			);
		});
	});
});

describe("resolveSpawnPair — explicit classes (both modes)", () => {
	test("a saved class resolves the stored pair through the registry (A4)", () => {
		withAgentDir({ heavy: STORED_HEAVY }, () => {
			for (const mode of ["plain", "repoOwner"] as const) {
				expect(resolveSpawnPair(mode, "heavy", ctx(SESSION, REGISTRY), "high")).toEqual(STORED_HEAVY);
			}
		});
	});

	test("old cheap/smart names keep working (compat)", () => {
		withAgentDir({ cheap: { model: "prov-a/model-a", thinking: "low" }, smart: STORED_HEAVY }, () => {
			expect(resolveSpawnPair("plain", "cheap", ctx(SESSION, REGISTRY), "high")).toEqual({
				model: "prov-a/model-a",
				thinking: "low",
			});
			expect(resolveSpawnPair("plain", "smart", ctx(SESSION, REGISTRY), "high")).toEqual(STORED_HEAVY);
		});
	});

	test("corrupt storage fails an explicitly requested class, never masked", () => {
		withAgentDir(CORRUPT, () => {
			expect(() => resolveSpawnPair("plain", "smart", ctx(SESSION, REGISTRY), "high")).toThrow(/corrupt/);
		});
	});

	test("an unset class throws before any child could be started, listing saved classes", () => {
		withAgentDir({ heavy: STORED_HEAVY }, () => {
			expect(() => resolveSpawnPair("plain", "cheap", ctx(SESSION, REGISTRY), "high")).toThrow(
				/Model class "cheap" is not saved[\s\S]*heavy/,
			);
		});
	});

	test("`constructor` (inherited Object property) behaves exactly like an unknown class name", () => {
		withAgentDir({ heavy: STORED_HEAVY }, () => {
			expect(() => resolveSpawnPair("plain", "constructor", ctx(SESSION, REGISTRY), "high")).toThrow(
				/Model class "constructor" is not saved[\s\S]*heavy/,
			);
		});
	});

	test("a stored model that is gone from the registry throws with no fallback", () => {
		withAgentDir({ heavy: { model: "prov-gone/vanished", thinking: "high" } }, () => {
			expect(() => resolveSpawnPair("plain", "heavy", ctx(SESSION, REGISTRY), "high")).toThrow(
				/no longer available/,
			);
		});
	});
});

describe("resolveSpawnPair — spawn-mode routing (R3)", () => {
	test("omitted + route for the mode -> the routed pair, not the session pair (A2 cost isolation)", () => {
		withAgentDir({ workhorse: { model: "prov-a/model-a", thinking: "low" }, routing: { plain: "workhorse" } }, () => {
			// session runs heavy: the plain child still gets the workhorse pair
			expect(
				resolveSpawnPair(
					"plain",
					undefined,
					ctx({ provider: "prov-b", id: "openai/gpt-oss-120b" }, REGISTRY),
					"xhigh",
				),
			).toEqual({ model: "prov-a/model-a", thinking: "low" });
		});
	});

	test("routing is per mode: an unrouted plain inherits the session pair (A3)", () => {
		// no saved heavy class: the unrouted repoOwner also falls to the session pair
		withAgentDir({ deep: STORED_HEAVY, routing: { plain: "deep" } }, () => {
			expect(resolveSpawnPair("repoOwner", undefined, ctx(SESSION, REGISTRY), "high")).toEqual({
				model: "prov-a/model-a",
				thinking: "high",
			});
		});
		withAgentDir({ heavy: STORED_HEAVY, routing: { repoOwner: "heavy" } }, () => {
			expect(resolveSpawnPair("plain", undefined, ctx(SESSION, REGISTRY), "high")).toEqual({
				model: "prov-a/model-a",
				thinking: "high",
			});
		});
	});

	test("omitted repoOwner with a saved heavy and no route -> the implicit heavy pair, not the session pair", () => {
		withAgentDir({ heavy: STORED_HEAVY }, () => {
			expect(resolveSpawnPair("repoOwner", undefined, ctx(SESSION, REGISTRY), "low")).toEqual(STORED_HEAVY);
			// plain never consults the implicit class
			expect(resolveSpawnPair("plain", undefined, ctx(SESSION, REGISTRY), "low")).toEqual({
				model: "prov-a/model-a",
				thinking: "low",
			});
		});
	});

	test("unresolvable implicit heavy (dead model) fails closed at the spawn boundary", () => {
		withAgentDir({ heavy: { model: "prov-gone/vanished", thinking: "high" } }, () => {
			expect(() => resolveSpawnPair("repoOwner", undefined, ctx(SESSION, REGISTRY), "high")).toThrow(
				/RepoOwner default model class "heavy"[\s\S]*no longer available[\s\S]*pass modelClass explicitly/,
			);
		});
	});

	test("repoOwner routing decouples the owner from the session model (A3)", () => {
		withAgentDir({ heavy: STORED_HEAVY, routing: { repoOwner: "heavy" } }, () => {
			expect(resolveSpawnPair("repoOwner", undefined, ctx(SESSION, REGISTRY), "low")).toEqual(STORED_HEAVY);
		});
	});

	test("explicit \"default\" overrides routing for both modes (A5 escape hatch)", () => {
		withAgentDir({ heavy: STORED_HEAVY, routing: { plain: "heavy", repoOwner: "heavy" } }, () => {
			for (const mode of ["plain", "repoOwner"] as const) {
				expect(resolveSpawnPair(mode, "default", ctx(SESSION, REGISTRY), "medium")).toEqual({
					model: "prov-a/model-a",
					thinking: "medium",
				});
			}
		});
	});

	test("explicit saved class overrides routing (A4)", () => {
		withAgentDir(
			{
				workhorse: { model: "prov-a/model-a", thinking: "low" },
				heavy: STORED_HEAVY,
				routing: { plain: "heavy", repoOwner: "workhorse" },
			},
			() => {
				expect(resolveSpawnPair("plain", "workhorse", ctx(SESSION, REGISTRY), "high")).toEqual({
					model: "prov-a/model-a",
					thinking: "low",
				});
				expect(resolveSpawnPair("repoOwner", "heavy", ctx(SESSION, REGISTRY), "high")).toEqual(STORED_HEAVY);
			},
		);
	});

	test("route to a class that is not saved fails closed naming class, mode, and fix (A6)", () => {
		withAgentDir({ routing: { repoOwner: "nosuch" } }, () => {
			expect(() => resolveSpawnPair("repoOwner", undefined, ctx(SESSION, REGISTRY), "high")).toThrow(
				/routing for mode "repoOwner" is set to class "nosuch"[\s\S]*\/model-class route repoOwner <class\|inherit>[\s\S]*\/model-class nosuch set/,
			);
			// the plain mode is unaffected by the broken repoOwner route
			expect(resolveSpawnPair("plain", undefined, ctx(SESSION, REGISTRY), "high")).toEqual({
				model: "prov-a/model-a",
				thinking: "high",
			});
		});
	});

	test("route to a dead model fails closed the same way (A7)", () => {
		withAgentDir({ workhorse: { model: "prov-gone/vanished", thinking: "high" }, routing: { plain: "workhorse" } }, () => {
			expect(() => resolveSpawnPair("plain", undefined, ctx(SESSION, REGISTRY), "high")).toThrow(
				/no longer available/,
			);
		});
	});

	test("hand-edited routing to a non-class string target fails closed, not silent inheritance (A6, both modes)", () => {
		// "default" is a reserved word, not a saved class: it must fail as a
		// routing error — never be reinterpreted as the session-pair literal.
		withAgentDir({ heavy: STORED_HEAVY, routing: { repoOwner: "default" } }, () => {
			expect(() => resolveSpawnPair("repoOwner", undefined, ctx(SESSION, REGISTRY), "high")).toThrow(
				/routing for mode "repoOwner" is set to class "default"[\s\S]*is not saved[\s\S]*heavy/,
			);
		});
		// garbage grammar target: same failure shape, exactly like a dead class
		withAgentDir({ heavy: STORED_HEAVY, routing: { plain: "INVALID!" } }, () => {
			expect(() => resolveSpawnPair("plain", undefined, ctx(SESSION, REGISTRY), "high")).toThrow(
				/routing for mode "plain" is set to class "INVALID!"[\s\S]*\/model-class route plain <class\|inherit>/,
			);
		});
	});

	test("hand-edited non-object routing degrades to inheritance (cannot be a route at all)", () => {
		withAgentDir({ routing: "workhorse" }, () => {
			expect(resolveSpawnPair("plain", undefined, ctx(SESSION, REGISTRY), "high")).toEqual({
				model: "prov-a/model-a",
				thinking: "high",
			});
		});
	});
});
