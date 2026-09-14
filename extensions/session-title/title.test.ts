import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildTitlePrompt,
	modelClassesFile,
	readCheapModelClass,
	sanitizeTitle,
	TITLE_MAX_CODE_POINTS,
	TITLE_SYSTEM_PROMPT,
} from "./title";

describe("buildTitlePrompt", () => {
	test("wraps the first message without altering it", () => {
		const prompt = buildTitlePrompt("Fix the flaky login test");
		expect(prompt).toContain("<first-message>");
		expect(prompt).toContain("Fix the flaky login test");
		expect(prompt).toContain("Reply with the session title only.");
	});
});

describe("TITLE_SYSTEM_PROMPT", () => {
	test("asks for the user's language and bare title output", () => {
		expect(TITLE_SYSTEM_PROMPT).toContain("same language as the user's message");
		expect(TITLE_SYSTEM_PROMPT).toContain("3 to 8 words");
	});
});

describe("sanitizeTitle", () => {
	test("takes the first non-empty line", () => {
		expect(sanitizeTitle("\n  \nFix flaky login test\nSecond line")).toBe("Fix flaky login test");
	});

	test("strips code fences and backticks", () => {
		expect(sanitizeTitle("```\nFix flaky login test\n```")).toBe("Fix flaky login test");
		expect(sanitizeTitle("`Fix flaky login test`")).toBe("Fix flaky login test");
	});

	test("strips wrapping quotes and dashes, keeps inner punctuation", () => {
		expect(sanitizeTitle('"Fix flaky login test"')).toBe("Fix flaky login test");
		expect(sanitizeTitle("«Починить флакующий тест»")).toBe("Починить флакующий тест");
		expect(sanitizeTitle("- Починить флакующий тест")).toBe("Починить флакующий тест");
		expect(sanitizeTitle("Fix don't-break-oauth test")).toBe("Fix don't-break-oauth test");
	});

	test("drops a single trailing period", () => {
		expect(sanitizeTitle("Fix flaky login test.")).toBe("Fix flaky login test");
		expect(sanitizeTitle("Fix login?")).toBe("Fix login?");
	});

	test("truncates by code points, not UTF-16 units", () => {
		const cyrillic = "А".repeat(TITLE_MAX_CODE_POINTS + 30);
		const result = sanitizeTitle(cyrillic);
		expect(result).toBeDefined();
		expect(Array.from(result!).length).toBe(TITLE_MAX_CODE_POINTS);
	});

	test("returns undefined for empty or punctuation-only output", () => {
		expect(sanitizeTitle("")).toBeUndefined();
		expect(sanitizeTitle("   \n  ")).toBeUndefined();
		expect(sanitizeTitle('"""')).toBeUndefined();
	});
});

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readCheapModelClass", () => {
	test("reads the saved cheap class canonical id", () => {
		const file = writeClasses({ cheap: { model: "zai/glm-5.3-flash", thinking: "off" } });
		expect(readCheapModelClass(file)).toBe("zai/glm-5.3-flash");
	});

	test("supports model ids containing slashes", () => {
		const file = writeClasses({ cheap: { model: "cloudru/deepseek-ai/DeepSeek-V4-Pro", thinking: "low" } });
		expect(readCheapModelClass(file)).toBe("cloudru/deepseek-ai/DeepSeek-V4-Pro");
	});

	test("returns undefined for missing, malformed, or empty entries", () => {
		expect(readCheapModelClass(join(tmpdir(), "session-title-no-such-file.json"))).toBeUndefined();
		expect(readCheapModelClass(writeClasses({}))).toBeUndefined();
		expect(readCheapModelClass(writeClasses({ cheap: { thinking: "off" } }))).toBeUndefined();
		expect(readCheapModelClass(writeClasses({ cheap: { model: "no-slash", thinking: "off" } }))).toBeUndefined();
		expect(readCheapModelClass(writeClasses({ cheap: { model: "/leading", thinking: "off" } }))).toBeUndefined();
		expect(readCheapModelClass(writeClasses({ cheap: { model: "trailing/", thinking: "off" } }))).toBeUndefined();
		expect(readCheapModelClass(writeBroken())).toBeUndefined();
	});

	function writeClasses(classes: Record<string, unknown>): string {
		const dir = mkdtempSync(join(tmpdir(), "session-title-"));
		tempDirs.push(dir);
		const file = join(dir, "model-classes.json");
		writeFileSync(file, JSON.stringify(classes));
		return file;
	}

	function writeBroken(): string {
		const dir = mkdtempSync(join(tmpdir(), "session-title-"));
		tempDirs.push(dir);
		const file = join(dir, "model-classes.json");
		writeFileSync(file, "{ not json");
		return file;
	}
});

describe("modelClassesFile", () => {
	test("honors PI_CODING_AGENT_DIR", () => {
		expect(modelClassesFile({ PI_CODING_AGENT_DIR: "/custom/agent-dir" })).toBe("/custom/agent-dir/model-classes.json");
		expect(modelClassesFile({})).toContain(join(".pi", "agent"));
	});
});
