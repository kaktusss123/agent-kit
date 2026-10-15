/**
 * Unit tests for model-classes persistence: named
 * classes (grammar + reserved words + insertion order), migration of old
 * cheap/smart files, routing read/write/reset, unset protection, atomic
 * failure keeping the previous value, corrupt-file handling, agent-dir
 * redirection.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	isClassName,
	loadModelClasses,
	loadStoredFile,
	modelClassesPath,
	parseStoredPair,
	saveModelClass,
	saveRouting,
	unsetModelClass,
} from "./store";

function tmpFile(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "model-classes-store-")), "model-classes.json");
}

describe("modelClassesPath", () => {
	test("honors PI_CODING_AGENT_DIR, defaults to ~/.pi/agent", () => {
		const prev = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = "/custom/agent/dir";
			expect(modelClassesPath()).toBe("/custom/agent/dir/model-classes.json");
			delete process.env.PI_CODING_AGENT_DIR;
			expect(modelClassesPath()).toBe(path.join(os.homedir(), ".pi", "agent", "model-classes.json"));
			expect(modelClassesPath("/explicit")).toBe("/explicit/model-classes.json");
		} finally {
			if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prev;
		}
	});
});

describe("class-name grammar (R1)", () => {
	test("accepts lowercase names with digits and dashes", () => {
		for (const good of ["a", "cheap", "smart", "workhorse", "heavy", "deep-review-2", "c".repeat(32)]) {
			expect(isClassName(good), good).toBe(true);
		}
	});

	test("rejects grammar violations", () => {
		for (const bad of [
			"",
			"Cheap",
			"1st",
			"-lead",
			"under_score",
			"dot.name",
			"with space",
			"c".repeat(33),
		]) {
			expect(isClassName(bad), bad).toBe(false);
		}
	});

	test("rejects every reserved word", () => {
		for (const word of ["default", "inherit", "route", "next", "set", "unset", "routing"]) {
			expect(isClassName(word), word).toBe(false);
		}
	});
});

describe("save/load round-trip", () => {
	test("set then load from disk (restart/reload persistence)", () => {
		const file = tmpFile();
		saveModelClass(file, "workhorse", { model: "cloudru/openai/gpt-oss-120b", thinking: "medium" });
		expect(loadModelClasses(file)).toEqual({
			workhorse: { model: "cloudru/openai/gpt-oss-120b", thinking: "medium" },
		});
		// A fresh load call simulates a new process: no in-memory caching.
		expect(loadModelClasses(file).workhorse?.thinking).toBe("medium");
	});

	test("saving one class preserves the other, routing, and unknown keys", () => {
		const file = tmpFile();
		saveModelClass(file, "workhorse", { model: "a/m1", thinking: "low" });
		saveModelClass(file, "heavy", { model: "b/m2", thinking: "xhigh" });
		saveRouting(file, "plain", "workhorse");
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		expect(raw.routing).toEqual({ plain: "workhorse" });
		saveModelClass(file, "heavy", { model: "b/m2", thinking: "high" });
		const after = JSON.parse(fs.readFileSync(file, "utf8"));
		expect(after.workhorse).toEqual({ model: "a/m1", thinking: "low" });
		expect(after.heavy).toEqual({ model: "b/m2", thinking: "high" });
		expect(after.routing).toEqual({ plain: "workhorse" });
	});

	test("storage (insertion) order survives writes and reloads (R1 cycling order)", () => {
		const file = tmpFile();
		saveModelClass(file, "workhorse", { model: "a/m1", thinking: "low" });
		saveModelClass(file, "heavy", { model: "b/m2", thinking: "high" });
		saveModelClass(file, "deep", { model: "c/m3", thinking: "max" });
		expect(Object.keys(loadModelClasses(file))).toEqual(["workhorse", "heavy", "deep"]);
		// re-set does not move a class to the end
		saveModelClass(file, "workhorse", { model: "a/m1", thinking: "medium" });
		expect(Object.keys(loadModelClasses(file))).toEqual(["workhorse", "heavy", "deep"]);
	});

	test("migration: an old cheap/smart-only file loads as ordinary classes, no routing", () => {
		const file = tmpFile();
		fs.writeFileSync(
			file,
			JSON.stringify({
				cheap: { model: "cloudru/openai/gpt-oss-120b", thinking: "medium" },
				smart: { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
			}),
		);
		const stored = loadStoredFile(file);
		expect(stored.classes).toEqual({
			cheap: { model: "cloudru/openai/gpt-oss-120b", thinking: "medium" },
			smart: { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
		});
		expect(stored.routing).toEqual({});
	});

	test("re-set replaces without confirmation", () => {
		const file = tmpFile();
		saveModelClass(file, "smart", { model: "old/m", thinking: "low" });
		saveModelClass(file, "smart", { model: "new/m", thinking: "max" });
		expect(loadModelClasses(file).smart).toEqual({ model: "new/m", thinking: "max" });
	});

	test("garbage keys and invalid entries degrade to not set; valid entries survive", () => {
		const file = tmpFile();
		fs.writeFileSync(
			file,
			JSON.stringify({
				workhorse: { model: "ok/m", thinking: "high" },
				smart: { model: "", thinking: "high" },
				NotAClass: { model: "x/m", thinking: "high" },
				"default": { model: "x/m", thinking: "high" },
				whatever: 42,
			}),
		);
		expect(loadModelClasses(file)).toEqual({ workhorse: { model: "ok/m", thinking: "high" } });
	});

	test("the reserved `routing` key never loads as a class", () => {
		const file = tmpFile();
		fs.writeFileSync(
			file,
			JSON.stringify({ workhorse: { model: "a/m", thinking: "low" }, routing: { plain: "workhorse" } }),
		);
		const stored = loadStoredFile(file);
		expect(Object.keys(stored.classes)).toEqual(["workhorse"]);
		expect(stored.routing).toEqual({ plain: "workhorse" });
	});
});

describe("routing storage (R3)", () => {
	test("route set persists per mode and resets with inherit", () => {
		const file = tmpFile();
		saveRouting(file, "plain", "workhorse");
		saveRouting(file, "repoOwner", "heavy");
		expect(loadStoredFile(file).routing).toEqual({ plain: "workhorse", repoOwner: "heavy" });
		saveRouting(file, "plain", "inherit");
		expect(loadStoredFile(file).routing).toEqual({ repoOwner: "heavy" });
		// resetting the last entry leaves an empty-but-present table
		saveRouting(file, "repoOwner", "inherit");
		expect(loadStoredFile(file).routing).toEqual({});
	});

	test("partial tables load as-is (one mode routed, the other inherits)", () => {
		const file = tmpFile();
		fs.writeFileSync(file, JSON.stringify({ routing: { plain: "workhorse" } }));
		expect(loadStoredFile(file).routing).toEqual({ plain: "workhorse" });
	});

	test("hand-edited routing garbage: unknown modes and non-string targets dropped", () => {
		const file = tmpFile();
		fs.writeFileSync(
			file,
			JSON.stringify({
				routing: {
					plain: "workhorse",
					bogusMode: "heavy",
					repoOwner: 42,
					alsoBad: null,
				},
			}),
		);
		expect(loadStoredFile(file).routing).toEqual({ plain: "workhorse" });
	});

	test("string routing targets are preserved even when not valid/saved class names (D4/A6 fail closed)", () => {
		const file = tmpFile();
		fs.writeFileSync(
			file,
			JSON.stringify({ routing: { repoOwner: "INVALID!", plain: "default" } }),
		);
		// preserved structurally: a present route is unknown-but-set state
		// that fails closed at spawn resolution — never silently dropped
		expect(loadStoredFile(file).routing).toEqual({ repoOwner: "INVALID!", plain: "default" });
	});

	test("a route to a class that is not saved loads fine (flagged at spawn/status, R2)", () => {
		const file = tmpFile();
		fs.writeFileSync(file, JSON.stringify({ routing: { plain: "nosuch" } }));
		expect(loadStoredFile(file).routing).toEqual({ plain: "nosuch" });
	});

	test("routing preserves classes and unknown keys (read-modify-write)", () => {
		const file = tmpFile();
		saveModelClass(file, "workhorse", { model: "a/m1", thinking: "low" });
		fs.writeFileSync(
			file,
			JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), future: [1, 2] }),
		);
		saveRouting(file, "plain", "workhorse");
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		expect(raw.workhorse).toEqual({ model: "a/m1", thinking: "low" });
		expect(raw.future).toEqual([1, 2]);
		expect(raw.routing).toEqual({ plain: "workhorse" });
	});

	test("failed routing write leaves the previous file valid and no tmp litter", () => {
		const file = tmpFile();
		saveModelClass(file, "workhorse", { model: "a/m1", thinking: "low" });
		saveRouting(file, "plain", "workhorse");
		const dir = path.dirname(file);
		fs.chmodSync(dir, 0o555);
		try {
			expect(() => saveRouting(file, "plain", "heavy")).toThrow();
		} finally {
			fs.chmodSync(dir, 0o755);
		}
		expect(loadStoredFile(file).routing).toEqual({ plain: "workhorse" });
		expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	test("routing write on corrupt storage fails and leaves the file untouched", () => {
		const file = tmpFile();
		saveRouting(file, "plain", "workhorse");
		fs.writeFileSync(file, "{ not json");
		const before = fs.readFileSync(file, "utf8");
		expect(() => saveRouting(file, "plain", "heavy")).toThrow(/corrupt/);
		expect(fs.readFileSync(file, "utf8")).toBe(before);
	});
});

describe("unset (R1)", () => {
	test("deletes a saved class and keeps everything else", () => {
		const file = tmpFile();
		saveModelClass(file, "workhorse", { model: "a/m1", thinking: "low" });
		saveModelClass(file, "heavy", { model: "b/m2", thinking: "high" });
		expect(unsetModelClass(file, "workhorse")).toEqual({ ok: true, deleted: true });
		expect(loadModelClasses(file)).toEqual({ heavy: { model: "b/m2", thinking: "high" } });
	});

	test("refuses while any routing entry references the class, naming the modes (A8)", () => {
		const file = tmpFile();
		saveModelClass(file, "heavy", { model: "b/m2", thinking: "high" });
		saveRouting(file, "repoOwner", "heavy");
		const outcome = unsetModelClass(file, "heavy");
		expect(outcome).toMatchObject({ ok: false, referencedBy: ["repoOwner"] });
		expect(outcome.ok === false && outcome.error).toContain("repoOwner");
		expect(outcome.ok === false && outcome.error).toContain("/model-class route <mode> inherit");
		// the class is still there
		expect(loadModelClasses(file).heavy).toBeDefined();

		saveRouting(file, "plain", "heavy");
		const both = unsetModelClass(file, "heavy");
		expect(both).toMatchObject({ ok: false, referencedBy: ["plain", "repoOwner"] });

		// after resetting both routes, unset succeeds
		saveRouting(file, "repoOwner", "inherit");
		saveRouting(file, "plain", "inherit");
		expect(unsetModelClass(file, "heavy")).toEqual({ ok: true, deleted: true });
		expect(loadModelClasses(file).heavy).toBeUndefined();
	});

	test("unset of a class that is not saved is an honest no-op", () => {
		const file = tmpFile();
		expect(unsetModelClass(file, "nosuch")).toEqual({ ok: true, deleted: false });
	});

	test("unset on corrupt storage fails and leaves the file untouched", () => {
		const file = tmpFile();
		saveModelClass(file, "heavy", { model: "b/m2", thinking: "high" });
		fs.writeFileSync(file, "{ not json");
		const before = fs.readFileSync(file, "utf8");
		expect(() => unsetModelClass(file, "heavy")).toThrow(/corrupt/);
		expect(fs.readFileSync(file, "utf8")).toBe(before);
	});
});

describe("failure semantics", () => {
	test("failed write leaves the previous persisted value valid", () => {
		const file = tmpFile();
		saveModelClass(file, "cheap", { model: "good/m", thinking: "high" });
		// Directory made read-only → the tmp+rename write must fail.
		const dir = path.dirname(file);
		fs.chmodSync(dir, 0o555);
		try {
			expect(() => saveModelClass(file, "cheap", { model: "bad/m", thinking: "low" })).toThrow();
		} finally {
			fs.chmodSync(dir, 0o755);
		}
		expect(loadModelClasses(file).cheap).toEqual({ model: "good/m", thinking: "high" });
		// No tmp litter left behind.
		expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	test("set on corrupt storage fails and leaves the file byte-for-byte untouched", () => {
		const file = tmpFile();
		saveModelClass(file, "smart", { model: "keep/m", thinking: "xhigh" });
		fs.writeFileSync(file, "{ not json");
		const before = fs.readFileSync(file, "utf8");
		expect(() => saveModelClass(file, "cheap", { model: "new/m", thinking: "low" })).toThrow();
		expect(fs.readFileSync(file, "utf8")).toBe(before); // smart not silently destroyed
	});

	test("set on unreadable storage fails and leaves the file untouched", () => {
		if (typeof process.getuid === "function" && process.getuid() === 0) return; // root reads anyway
		const file = tmpFile();
		saveModelClass(file, "smart", { model: "keep/m", thinking: "xhigh" });
		fs.chmodSync(file, 0o000);
		try {
			expect(() => saveModelClass(file, "cheap", { model: "new/m", thinking: "low" })).toThrow();
		} finally {
			fs.chmodSync(file, 0o644);
		}
		expect(loadModelClasses(file).smart).toEqual({ model: "keep/m", thinking: "xhigh" });
	});

	test("an empty storage file starts fresh (carries no classes to lose)", () => {
		const file = tmpFile();
		fs.writeFileSync(file, "");
		saveModelClass(file, "cheap", { model: "a/m", thinking: "low" });
		expect(loadModelClasses(file).cheap).toEqual({ model: "a/m", thinking: "low" });
	});

	test("a class literally named `constructor` round-trips (own-property storage)", () => {
		const file = tmpFile();
		saveModelClass(file, "constructor", { model: "a/m", thinking: "low" });
		saveModelClass(file, "workhorse", { model: "b/m2", thinking: "high" });
		expect(loadModelClasses(file)).toEqual({
			constructor: { model: "a/m", thinking: "low" },
			workhorse: { model: "b/m2", thinking: "high" },
		});
	});

	test("missing file loads as empty", () => {
		expect(loadModelClasses(path.join(os.tmpdir(), `mc-none-${Date.now()}.json`))).toEqual({});
	});

	test("an empty storage file loads as empty classes and routing, like a missing file", () => {
		const file = tmpFile();
		fs.writeFileSync(file, "");
		expect(loadStoredFile(file)).toEqual({ classes: {}, routing: {} });
	});

	test("a whitespace-only storage file loads as empty, like a missing file", () => {
		const file = tmpFile();
		fs.writeFileSync(file, "  \n\t ");
		expect(loadStoredFile(file)).toEqual({ classes: {}, routing: {} });
	});

	test("corrupt JSON throws instead of silently dropping saved classes", () => {
		const file = tmpFile();
		fs.writeFileSync(file, "{ not json");
		expect(() => loadModelClasses(file)).toThrow(/corrupt/);
	});

	test("invalid entries degrade to not set; valid entries survive", () => {
		const file = tmpFile();
		fs.writeFileSync(
			file,
			JSON.stringify({
				cheap: { model: "ok/m", thinking: "high" },
				smart: { model: "", thinking: "high" },
			}),
		);
		const loaded = loadModelClasses(file);
		expect(loaded.cheap).toEqual({ model: "ok/m", thinking: "high" });
		expect(loaded.smart).toBeUndefined();
	});
});

describe("parseStoredPair", () => {
	test("accepts only valid model + thinking pairs", () => {
		expect(parseStoredPair({ model: "a/b", thinking: "medium" })).toEqual({ model: "a/b", thinking: "medium" });
		expect(parseStoredPair({ model: "a/b", thinking: "off" })).toBeDefined();
		for (const bad of [
			undefined,
			null,
			"string",
			{},
			{ model: "", thinking: "high" },
			{ model: "a/b" },
			{ model: "a/b", thinking: "ultra" },
			{ model: 42, thinking: "high" },
		]) {
			expect(parseStoredPair(bad)).toBeUndefined();
		}
	});
});
