/**
 * Unit tests for model-classes persistence (SPEC §4, §10):
 * round-trip, restart reload, re-set overwrite, atomic failure keeping the
 * previous value, corrupt-file handling, agent-dir redirection.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	loadModelClasses,
	modelClassesPath,
	parseStoredPair,
	saveModelClass,
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

describe("save/load round-trip", () => {
	test("set then load from disk (restart/reload persistence, A2)", () => {
		const file = tmpFile();
		saveModelClass(file, "cheap", { model: "cloudru/openai/gpt-oss-120b", thinking: "medium" });
		expect(loadModelClasses(file)).toEqual({
			cheap: { model: "cloudru/openai/gpt-oss-120b", thinking: "medium" },
		});
		// A fresh load call simulates a new process: no in-memory caching.
		expect(loadModelClasses(file).cheap?.thinking).toBe("medium");
	});

	test("saving one class preserves the other and unknown keys", () => {
		const file = tmpFile();
		saveModelClass(file, "cheap", { model: "a/m1", thinking: "low" });
		saveModelClass(file, "smart", { model: "b/m2", thinking: "xhigh" });
		expect(loadModelClasses(file)).toEqual({
			cheap: { model: "a/m1", thinking: "low" },
			smart: { model: "b/m2", thinking: "xhigh" },
		});
		fs.writeFileSync(file, JSON.stringify({ cheap: { model: "a/m1", thinking: "low" }, future: 1 }));
		saveModelClass(file, "smart", { model: "b/m2", thinking: "high" });
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		expect(raw.future).toBe(1);
		expect(raw.smart).toEqual({ model: "b/m2", thinking: "high" });
	});

	test("re-set replaces without confirmation (A6)", () => {
		const file = tmpFile();
		saveModelClass(file, "smart", { model: "old/m", thinking: "low" });
		saveModelClass(file, "smart", { model: "new/m", thinking: "max" });
		expect(loadModelClasses(file).smart).toEqual({ model: "new/m", thinking: "max" });
	});
});

describe("failure semantics", () => {
	test("failed write leaves the previous persisted value valid (A12)", () => {
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

	test("set on corrupt storage fails and leaves the file byte-for-byte untouched (F1)", () => {
		const file = tmpFile();
		saveModelClass(file, "smart", { model: "keep/m", thinking: "xhigh" });
		fs.writeFileSync(file, "{ not json");
		const before = fs.readFileSync(file, "utf8");
		expect(() => saveModelClass(file, "cheap", { model: "new/m", thinking: "low" })).toThrow();
		expect(fs.readFileSync(file, "utf8")).toBe(before); // smart not silently destroyed
	});

	test("set on unreadable storage fails and leaves the file untouched (F1)", () => {
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

	test("missing file loads as empty", () => {
		expect(loadModelClasses(path.join(os.tmpdir(), `mc-none-${Date.now()}.json`))).toEqual({});
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
