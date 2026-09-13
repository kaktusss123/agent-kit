/**
 * Unit tests for the live operator observability formatting: bounded tool
 * activity summaries and the workspace run status view. Pure module — no pi,
 * no child processes, deterministic clocks.
 */
import { describe, expect, test } from "bun:test";
import { formatRunStatus, summarizeToolActivity, type RunStatusView } from "./activity";
import type { ToolActivity } from "./types";

describe("summarizeToolActivity", () => {
	test("bash command extracted, single-line, bounded", () => {
		expect(summarizeToolActivity("bash", { command: "bun test extensions/subagents" })).toBe(
			"bun test extensions/subagents",
		);
	});

	test("multi-line command is flattened to one line", () => {
		expect(summarizeToolActivity("bash", { command: "a\nb\tc  d" })).toBe("a b c d");
	});

	test("control characters are collapsed, not carried through", () => {
		const s = summarizeToolActivity("bash", { command: "echo\u0000hi\u001fb" });
		expect(s).toBe("echo hi b");
	});

	test("long commands truncate aggressively with an ellipsis", () => {
		const s = summarizeToolActivity("bash", { command: "x".repeat(200) });
		expect(s?.length).toBe(72 + 1); // cap + ellipsis
		expect(s?.endsWith("…")).toBe(true);
	});

	test("path-shaped arguments are extracted for file tools", () => {
		expect(summarizeToolActivity("edit", { path: "extensions/subagents/readiness.ts" })).toBe(
			"extensions/subagents/readiness.ts",
		);
		expect(summarizeToolActivity("write", { file_path: "/tmp/a.txt", content: "SECRET" })).toBe("/tmp/a.txt");
	});

	test("search query and pattern keys are extracted", () => {
		expect(summarizeToolActivity("grep", { pattern: "tool_execution_start", path: "/x" })).toBe(
			"tool_execution_start",
		);
		expect(summarizeToolActivity("web_search", { query: "pi rpc protocol" })).toBe("pi rpc protocol");
	});

	test("key priority: command beats path when both exist", () => {
		expect(summarizeToolActivity("bash", { command: "ls", path: "/tmp" })).toBe("ls");
	});

	test("no allow-listed key → undefined; NEVER serializes the input blob", () => {
		expect(summarizeToolActivity("write", { content: "entire file body with secrets" })).toBeUndefined();
		expect(summarizeToolActivity("read", {})).toBeUndefined();
		expect(summarizeToolActivity("read", { path: 42 })).toBeUndefined();
		expect(summarizeToolActivity("read", "not-an-object")).toBeUndefined();
		expect(summarizeToolActivity("read", null)).toBeUndefined();
		expect(summarizeToolActivity("read", undefined)).toBeUndefined();
	});

	test("whitespace-only candidates are skipped, later keys still tried", () => {
		expect(summarizeToolActivity("bash", { command: "   \n  ", path: "/tmp/fallback" })).toBe("/tmp/fallback");
	});
});

// ---------------------------------------------------------------- views

const BASE_NOW = 1_000_000;

function view(overrides?: Partial<RunStatusView>): RunStatusView {
	return {
		runId: "wr-1-8tw1",
		agentId: "sa-1-q625",
		workspace: "/home/vlad/.agent-kit/tasks/t1/agent-kit",
		state: "running",
		elapsedMs: 639_000,
		pid: 18432,
		model: "zai/glm-5.3-flash",
		thinking: "high",
		sessionId: "0199abcd",
		activeTool: { name: "bash", summary: "bun test extensions/subagents", startedAt: BASE_NOW - 18_000 },
		recentActivity: [
			{ name: "edit", summary: "extensions/subagents/readiness.ts", startedAt: 1, endedAt: 2 },
			{ name: "edit", summary: "extensions/subagents/reporting-bridge.ts", startedAt: 3, endedAt: 4 },
		],
		now: BASE_NOW,
		...overrides,
	};
}

describe("formatRunStatus", () => {
	test("identity block: run, state, elapsed, deadline, agent, workspace, model, session", () => {
		const text = formatRunStatus(view({ deadlineMsLeft: 261_000 }));
		expect(text).toContain("RepoOwner wr-1-8tw1");
		expect(text).toContain("running · 10m39s · deadline 4m21s");
		expect(text).toContain("agent      sa-1-q625 · pid 18432");
		expect(text).toContain("workspace  /home/vlad/.agent-kit/tasks/t1/agent-kit");
		expect(text).toContain("model      zai/glm-5.3-flash · high");
		expect(text).toContain("session    0199abcd");
	});

	test("current tool with name, summary and live age", () => {
		const text = formatRunStatus(view());
		expect(text).toContain("current\n  bash · bun test extensions/subagents · 18s");
	});

	test("recent activity rendered oldest-first, summaries shortened for the list", () => {
		const text = formatRunStatus(
			view({
				recentActivity: [
					{ name: "edit", summary: "x".repeat(80), startedAt: 1, endedAt: 2 },
					{ name: "bash", summary: "bun test", startedAt: 3, endedAt: 4 },
				],
			}),
		);
		expect(text).toContain("recent");
		expect(text).toContain(`edit · ${"x".repeat(48)}…`);
		expect(text).toContain("bash · bun test");
		// recent entries carry no elapsed suffix
		expect(text).not.toMatch(/bun test · \d+s/);
	});

	test("report recovery ladder surfaced only when active", () => {
		expect(formatRunStatus(view({ ladder: { step: 2, max: 3 } }))).toContain("report recovery 2/3");
		expect(formatRunStatus(view())).not.toContain("report recovery");
	});

	test("sections without data are omitted — never fabricated", () => {
		const text = formatRunStatus(
			view({ activeTool: undefined, recentActivity: undefined, sessionId: undefined, sessionFile: undefined }),
		);
		expect(text).not.toContain("current");
		expect(text).not.toContain("recent");
		expect(text).not.toContain("session");
	});

	test("sessionFile is the fallback when no sessionId is known", () => {
		expect(formatRunStatus(view({ sessionId: undefined, sessionFile: "/s.jsonl" }))).toContain(
			"session    /s.jsonl",
		);
	});

	test("plain text only: no ANSI escapes, no JSON braces", () => {
		const text = formatRunStatus(view());
		expect(text).not.toMatch(/[\u001b\u009b]/);
		expect(text).not.toContain("{");
		expect(text).not.toContain("}");
	});

	test("waiting_input state renders truthfully", () => {
		expect(formatRunStatus(view({ state: "waiting_input" }))).toMatch(/^RepoOwner wr-1-8tw1\n\nwaiting_input · /);
	});

	test("age of the active tool uses the injected clock", () => {
		const text = formatRunStatus(view({ activeTool: { name: "bash", startedAt: BASE_NOW - 65_000 } }));
		expect(text).toContain("bash · 1m5s");
	});

	test("type shape: recent entries expose endedAt only (ToolActivity contract)", () => {
		const entry: ToolActivity = { name: "bash", summary: "x", startedAt: 1, endedAt: 2 };
		expect(entry.endedAt).toBe(2);
	});
});
