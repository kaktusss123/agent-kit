/**
 * Unit tests for the subagent spawn modelClass boundary (SPEC §6, §10):
 * `default` inherits the current Main pair, `cheap`/`smart` resolve stored
 * state, and an unresolvable class throws before any child could be
 * started — the tool calls this immediately before `runtime.spawn()`, so a
 * throw here IS the no-child guarantee (fail closed, no fallback).
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelLike } from "../model-classes/core";
import { resolveSpawnPair } from "./spawn-model";

const MAIN_MODEL: ModelLike = { provider: "prov-a", id: "model-a", reasoning: true };
const SMART_MODEL: ModelLike = {
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

const STORED_SMART = { model: "prov-b/openai/gpt-oss-120b", thinking: "xhigh" as const };

// Storage fixture: a throwaway PI_CODING_AGENT_DIR per case.
const tempDirs: string[] = [];
function spawnStorageDir(classes: Record<string, { model: string; thinking: string }> | string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-model-test-"));
	tempDirs.push(dir);
	const payload = typeof classes === "string" ? classes : JSON.stringify(classes);
	fs.writeFileSync(path.join(dir, "model-classes.json"), payload);
	return dir;
}
function withAgentDir<T>(
	classes: Record<string, { model: string; thinking: string }> | string,
	run: () => T,
): T {
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = spawnStorageDir(classes);
	try {
		return run();
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
}

/** Deliberately corrupt storage payload (F5 regression fixture). */
const CORRUPT = "{ not json";

describe("resolveSpawnPair — the spawn modelClass boundary", () => {
	test("default snapshots the current Main model + thinking, ignoring storage (A10, F5)", () => {
		// Hermetic AND regression in one: even a CORRUPT storage file must not
		// break the default path — default never reads saved classes.
		withAgentDir(CORRUPT, () => {
			const pair = resolveSpawnPair("default", ctx({ provider: "prov-a", id: "model-a" }, [MAIN_MODEL]), "high");
			expect(pair).toEqual({ model: "prov-a/model-a", thinking: "high" });
		});
		// Main switched since: the next spawn gets the new state, not a cache.
		withAgentDir(CORRUPT, () => {
			const switched = resolveSpawnPair(
				"default",
				ctx({ provider: "prov-b", id: "openai/gpt-oss-120b" }, [SMART_MODEL]),
				"medium",
			);
			expect(switched).toEqual({ model: "prov-b/openai/gpt-oss-120b", thinking: "medium" });
		});
	});

	test("smart resolves the stored pair through the registry (A11)", () => {
		withAgentDir({ smart: STORED_SMART }, () => {
			const pair = resolveSpawnPair(
				"smart",
				ctx({ provider: "prov-a", id: "model-a" }, [MAIN_MODEL, SMART_MODEL]),
				"high",
			);
			expect(pair).toEqual({ model: "prov-b/openai/gpt-oss-120b", thinking: "xhigh" });
		});
	});

	test("unset cheap throws before any child could be started (A7)", () => {
		withAgentDir({}, () => {
			expect(() =>
				resolveSpawnPair("cheap", ctx({ provider: "prov-a", id: "model-a" }, [MAIN_MODEL]), "high"),
			).toThrow('Model class "cheap" is not configured');
		});
	});

	test("a stored model that is gone from the registry throws with no fallback (A8)", () => {
		// smart points at a model the registry no longer lists.
		withAgentDir({ smart: { model: "prov-gone/vanished", thinking: "high" } }, () => {
			expect(() =>
				resolveSpawnPair("smart", ctx({ provider: "prov-a", id: "model-a" }, [MAIN_MODEL]), "high"),
			).toThrow(/no longer available/);
		});
	});

	test("default with no resolved session model throws instead of guessing", () => {
		expect(() => resolveSpawnPair("default", ctx(null, [MAIN_MODEL]), "high")).toThrow(
			/no model resolved in the current session/,
		);
	});
});
