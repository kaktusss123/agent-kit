import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildTitlePrompt,
	readExploreRoleModel,
	rolesFile,
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
		expect(TITLE_SYSTEM_PROMPT).toContain("2 to 4 words");
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

	test("backs off to the last full word when the cap cuts mid-word", () => {
		const long = "Fix flaky login and oauth tokens now"; // 36 code points.
		expect(Array.from(long).length).toBeGreaterThan(TITLE_MAX_CODE_POINTS);
		// Hard cut lands inside "tokens"; the partial word is dropped.
		expect(sanitizeTitle(long)).toBe("Fix flaky login and oauth");
	});

	test("returns undefined for empty or punctuation-only output", () => {
		expect(sanitizeTitle("")).toBeUndefined();
		expect(sanitizeTitle("   \n  ")).toBeUndefined();
		expect(sanitizeTitle('"""')).toBeUndefined();
	});
});

/** Minimal capture harness: registered handlers plus a fake TUI context. */
describe("terminal title wiring", () => {
	interface Harness {
		titles: string[];
		setName(value: string | undefined): void;
		fire(event: string, payload: unknown, mode?: "tui" | "rpc"): void;
	}

	function load(sessionName: string | undefined): Harness {
		const titles: string[] = [];
		let name = sessionName;
		const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
		const pi = {
			on: (event: string, cb: (event: unknown, ctx: ExtensionContext) => unknown) => {
				const list = handlers.get(event) ?? [];
				list.push(cb as never);
				handlers.set(event, list);
			},
			getSessionName: () => name,
		} as unknown as ExtensionAPI;
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		(require("./index.ts").default as (pi: ExtensionAPI) => void)(pi);
		const ctx = {
			mode: "tui",
			ui: { setTitle: (title: string) => titles.push(title) },
		} as unknown as ExtensionContext;
		return {
			titles,
			setName(value: string | undefined) {
				name = value;
			},
			fire(event, payload, mode = "tui") {
				handlers.get(event)?.[0]?.(payload, { ...ctx, mode });
			},
		};
	}

	const macro = () => new Promise((resolve) => setTimeout(resolve, 0));
	const renamed = { type: "session_info_changed", name: "Fix flaky login" };

	test("session_info_changed sets the bare title, then re-asserts on a macrotask", async () => {
		const ext = load("Fix flaky login");
		ext.fire("session_info_changed", renamed);
		expect(ext.titles).toEqual(["Fix flaky login"]);
		await macro(); // pi's own handler may repaint the composed title in between.
		expect(ext.titles).toEqual(["Fix flaky login", "Fix flaky login"]);
	});

	test("cleared session name leaves pi's default title alone", async () => {
		const ext = load(undefined);
		ext.fire("session_info_changed", { type: "session_info_changed", name: undefined });
		await macro();
		expect(ext.titles).toEqual([]);
	});

	test("clearing the name before the macrotask does not repaint the stale title", async () => {
		const ext = load("Fix flaky login");
		ext.fire("session_info_changed", renamed);
		expect(ext.titles).toEqual(["Fix flaky login"]);
		ext.setName(undefined); // User cleared while the re-assert was pending.
		await macro();
		expect(ext.titles).toEqual(["Fix flaky login"]); // pi's default title stays.
	});

	test("renaming before the macrotask repaints the fresh name", async () => {
		const ext = load("Fix flaky login");
		ext.fire("session_info_changed", renamed);
		ext.setName("Renamed mid-flight");
		await macro();
		expect(ext.titles).toEqual(["Fix flaky login", "Renamed mid-flight"]);
	});

	test("a newer event supersedes the pending re-assert instead of stacking paints", async () => {
		const ext = load("Fix flaky login");
		ext.fire("session_info_changed", renamed);
		ext.fire("session_info_changed", renamed);
		await macro();
		// Two immediate paints plus exactly ONE surviving re-assert (not two).
		expect(ext.titles).toEqual(["Fix flaky login", "Fix flaky login", "Fix flaky login"]);
	});

	test("session_start of a named session overrides pi's composed title immediately", () => {
		const ext = load("Fix flaky login");
		ext.fire("session_start", { type: "session_start", reason: "resume" });
		expect(ext.titles).toEqual(["Fix flaky login"]);
	});

	test("session_start without a name does not touch the title", () => {
		const ext = load(undefined);
		ext.fire("session_start", { type: "session_start", reason: "new" });
		expect(ext.titles).toEqual([]);
	});

	test("non-tui modes never set the title", async () => {
		const ext = load("Fix flaky login");
		ext.fire("session_start", { type: "session_start", reason: "resume" }, "rpc");
		ext.fire("session_info_changed", renamed, "rpc");
		await macro();
		expect(ext.titles).toEqual([]);
	});
});

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readExploreRoleModel", () => {
	test("reads the explore binding as a canonical id, dropping :thinking", () => {
		expect(readExploreRoleModel(writeRoles({ explore: "zai/glm-5.3-flash" }))).toBe("zai/glm-5.3-flash");
		expect(readExploreRoleModel(writeRoles({ explore: "zai/glm-5.3-flash:low" }))).toBe("zai/glm-5.3-flash");
	});

	test("supports model ids containing slashes and colons", () => {
		expect(readExploreRoleModel(writeRoles({ explore: "cloudru/deepseek-ai/DeepSeek-V4-Pro:low" }))).toBe(
			"cloudru/deepseek-ai/DeepSeek-V4-Pro",
		);
		expect(readExploreRoleModel(writeRoles({ explore: "ollama/qwen3:8b" }))).toBe("ollama/qwen3:8b");
	});

	test("returns undefined for missing, malformed, or empty entries", () => {
		expect(readExploreRoleModel(join(tmpdir(), "session-title-no-such-file.json"))).toBeUndefined();
		expect(readExploreRoleModel(writeRoles({}))).toBeUndefined();
		expect(readExploreRoleModel(writeRoles({ review: "zai/glm" }))).toBeUndefined();
		expect(readExploreRoleModel(writeRoles({ explore: 3 }))).toBeUndefined();
		expect(readExploreRoleModel(writeRoles({ explore: "no-slash" }))).toBeUndefined();
		expect(readExploreRoleModel(writeRoles({ explore: "/leading" }))).toBeUndefined();
		expect(readExploreRoleModel(writeRoles({ explore: "trailing/" }))).toBeUndefined();
		expect(readExploreRoleModel(writeBroken())).toBeUndefined();
	});

	function writeRoles(roles: Record<string, unknown>): string {
		const dir = mkdtempSync(join(tmpdir(), "session-title-"));
		tempDirs.push(dir);
		const file = join(dir, "subagent-roles.json");
		writeFileSync(file, JSON.stringify(roles));
		return file;
	}

	function writeBroken(): string {
		const dir = mkdtempSync(join(tmpdir(), "session-title-"));
		tempDirs.push(dir);
		const file = join(dir, "subagent-roles.json");
		writeFileSync(file, "{ not json");
		return file;
	}
});

describe("rolesFile", () => {
	test("honors PI_CODING_AGENT_DIR", () => {
		expect(rolesFile({ PI_CODING_AGENT_DIR: "/custom/agent-dir" })).toBe("/custom/agent-dir/subagent-roles.json");
		expect(rolesFile({ PI_CODING_AGENT_DIR: "" })).toContain(join(".pi", "agent"));
		expect(rolesFile({ PI_CODING_AGENT_DIR: "~/x" })).toBe(join(homedir(), "x", "subagent-roles.json"));
		expect(rolesFile({})).toContain(join(".pi", "agent"));
	});
});
