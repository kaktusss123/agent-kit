import { describe, expect, test } from "bun:test";
import { resolveAgentDir } from "./agent-dir";

describe("resolveAgentDir", () => {
	test("empty or missing env falls back to ~/.pi/agent", () => {
		expect(resolveAgentDir({}, "/h")).toBe("/h/.pi/agent");
		expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "" }, "/h")).toBe("/h/.pi/agent");
	});
	test("expands a leading tilde", () => {
		expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "~/x" }, "/h")).toBe("/h/x");
		expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "~" }, "/h")).toBe("/h");
	});
	test("keeps an absolute dir", () => {
		expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "/custom" }, "/h")).toBe("/custom");
	});
});
