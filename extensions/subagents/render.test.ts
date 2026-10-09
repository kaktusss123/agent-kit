import { describe, expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Envelope } from "./envelope";
import type { WorkspaceRunOutcome } from "./workspace-runs";
import { renderSubagentCall, renderSubagentResult } from "./render";

/** Plain-text fake theme: assertions read like `[accent]…[/accent]`. */
function fakeTheme(): Theme {
	const wrap = (color: string) => (text: string) => `[${color}]${text}[/${color}]`;
	return {
		fg: (color, text) => wrap(color)(text),
		bold: (text: string) => `**${text}**`,
		strikethrough: (text: string) => `~~${text}~~`,
	} as unknown as Theme;
}

// keyHint reads the live theme singleton; tests run without the TUI bootstrap.
initTheme();

const theme = fakeTheme();

/** Strip real ANSI escapes (keyHint uses the live theme) before asserting. */
function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function lines(component: { render: (width: number) => string[] }): string {
	return stripAnsi(component.render(400).join("\n"));
}

function renderLines(component: { render: (width: number) => string[] }): string[] {
	return component.render(400).map(stripAnsi);
}

function envelope(overrides: Partial<Envelope> = {}): Envelope {
	return {
		status: "done",
		summary: "Implemented the card renderer with tests.",
		changed_scope: ["extensions/subagents/render.ts", "extensions/subagents/render.test.ts", "extensions/subagents/index.ts"],
		verification: [
			{ check: "bun test extensions/subagents/", result: "pass" },
			{ check: "repo-root bun test", result: "fail", cwd: "/repo" },
		],
		gaps: ["README section pending"],
		contract_conflicts: ["spec asked for width-capped header"],
		...overrides,
	};
}

function outcome(overrides: Partial<WorkspaceRunOutcome> = {}): WorkspaceRunOutcome {
	return {
		status: "done",
		dispatched: true,
		workspace: "/home/vlad/.agent-kit/tasks/feat_card/agent-kit",
		agentId: "sa-2-ve6z",
		child_may_have_mutated_repo: false,
		git_facts: { branch: "feat/subagent_result_card", headSha: "a0e75c8abc123", dirty: { staged: [], unstaged: [] } },
		result: envelope(),
		...overrides,
	};
}

describe("renderSubagentCall", () => {
	test("workspace spawn shows workspace basename, label, capped task preview", () => {
		const text = lines(
			renderSubagentCall(
				{ op: "spawn", workspace: "/home/vlad/.agent-kit/tasks/feat_card/agent-kit", label: "card", task: "x".repeat(200) },
				theme,
			),
		);
		expect(text).toContain("subagent");
		expect(text).toContain("spawn");
		expect(text).toContain("workspace=agent-kit");
		expect(text).toContain("label=card");
		expect(text).toMatch(/x{80}…/);
		expect(text).not.toMatch(/x{81}/);
	});

	test("plain spawn falls back to cwd basename; other ops show id", () => {
		const spawn = lines(renderSubagentCall({ op: "spawn", cwd: "/repo/sub/dir", task: "do things" }, theme));
		expect(spawn).toContain("cwd=dir");
		expect(spawn).toContain("do things");
		const result = lines(renderSubagentCall({ op: "result", id: "sa-1" }, theme));
		expect(result).toContain("result");
		expect(result).toContain("id=sa-1");
	});

	test("explicit modelClass renders before the task preview; omitted renders nothing", () => {
		const explicit = lines(
			renderSubagentCall({ op: "spawn", workspace: "/tasks/feat/agent-kit", task: "own it", modelClass: "smart" }, theme),
		);
		expect(explicit).toContain("modelClass=smart");
		expect(explicit.indexOf("modelClass=smart")).toBeLessThan(explicit.indexOf("own it"));
		const dflt = lines(renderSubagentCall({ op: "spawn", cwd: "/repo", task: "t", modelClass: "default" }, theme));
		expect(dflt).toContain("modelClass=default");
		// omitted: no bogus class segment is invented
		const omitted = lines(renderSubagentCall({ op: "spawn", workspace: "/tasks/feat/agent-kit", task: "own it" }, theme));
		expect(omitted).not.toMatch(/model(=|Class=)/);
	});
});

describe("renderSubagentResult — non-card paths", () => {
	test("error results render the failure line", () => {
		const out = lines(
			renderSubagentResult({ isError: true, content: [{ type: "text", text: "boom" }] }, { expanded: false, isPartial: false }, theme),
		);
		expect(out).toContain("[error]✗ boom[/error]");
	});

	test("error with no text falls back to a generic message", () => {
		const out = lines(renderSubagentResult({ isError: true }, { expanded: false, isPartial: false }, theme));
		expect(out).toContain("✗ subagent op failed");
	});

	test("partial results pass the live snapshot through and survive missing content", () => {
		const out = lines(
			renderSubagentResult(
				{ content: [{ type: "text", text: "subagent sa-1 “worker” · running" }] },
				{ expanded: false, isPartial: true },
				theme,
			),
		);
		expect(out).toContain("subagent sa-1 “worker” · running");
		expect(() => renderSubagentResult({}, { expanded: false, isPartial: true }, theme)).not.toThrow();
	});

	test("plain management details render first text content verbatim", () => {
		const out = lines(
			renderSubagentResult(
				{
					content: [{ type: "text", text: "Spawned subagent sa-1 (“worker”) in /repo." }],
					details: { snapshot: { id: "sa-1", state: "running" } },
				},
				{ expanded: false, isPartial: false },
				theme,
			),
		);
		expect(out).toContain("Spawned subagent sa-1 (“worker”) in /repo.");
		expect(out).not.toContain("owner-");
	});

	test("AgentResult-shaped details do not match the workspace card", () => {
		const out = lines(
			renderSubagentResult(
				{
					content: [{ type: "text", text: "full result text" }],
					details: {
						result: { id: "sa-1", label: "worker", task: "t", cwd: "/repo", status: "completed", summary: "done things" },
					},
				},
				{ expanded: false, isPartial: false },
				theme,
			),
		);
		expect(out).toContain("full result text");
		expect(out).not.toContain("owner-");
		expect(out).not.toContain("checks");
	});

	test("op=result wraps the outcome in details.result and still renders the card", () => {
		const out = lines(
			renderSubagentResult(
				{
					content: [{ type: "text", text: '{"status":"done"}' }],
					details: { result: outcome() },
				},
				{ expanded: false, isPartial: false },
				theme,
			),
		);
		expect(out).toContain("done");
		expect(out).toContain("owner-agent-kit");
		expect(out).toContain("1/2 checks");
	});
});

describe("renderSubagentResult — workspace outcome card", () => {
	test.each(["running", "done", "partial", "blocked", "needs_input"] as const)("%s retains all bounded progress independently of runtime reason", (status) => {
		const progress = { achieved: "achieved result", currentWork: "current work", blocker: "claimed blocker", nextStep: "next step", updatedAt: 1000 };
		const details = outcome({ status, result: undefined, progress, progressAgeMs: 5000, deadlineMsLeft: 60000, reason: "runtime reason" });
		const before = structuredClone(details);
		const text = lines(renderSubagentResult({ details }, { expanded: false, isPartial: false }, theme));
		for (const field of ["achieved result", "current work", "claimed blocker", "next step", "age 5s", "runtime reason", "blocker (agent-reported)"]) expect(text).toContain(field);
		expect(details).toEqual(before);
		const absent = lines(renderSubagentResult({ details: { ...details, progress: undefined } }, { expanded: true, isPartial: false }, theme));
		expect(absent).toContain("progress: not reported");
		const malformed = lines(renderSubagentResult({ details: { ...details, progress: { ...progress, updatedAt: "bad" } } }, { expanded: true, isPartial: false }, theme));
		expect(malformed).toContain("progress: not reported");
	});
	test("collapsed done card shows status, repo identity, sha, clean tree, metrics, expand hint", () => {
		const text = lines(renderSubagentResult({ details: outcome() }, { expanded: false, isPartial: false }, theme));
		expect(text).toContain("✓ done");
		expect(text).toContain("owner-agent-kit");
		expect(text).toContain("(sa-2-ve6z)");
		expect(text).toContain("feat/subagent_result_card @ a0e75c8");
		expect(text).toContain("tree clean");
		expect(text).toContain("✗ 1/2 checks");
		expect(text).toContain("scope: extensions/subagents/render.ts");
		expect(text).toContain("render.test.ts");
		expect(text).toContain("+1 more");
		expect(text).toContain("to expand");
		expect(text).not.toContain("gaps:");
	});

	test("partial report over a done settle shows the report segment in the reported status color", () => {
		const text = lines(
			renderSubagentResult(
				{ details: outcome({ status: "done", result: envelope({ status: "partial" }) }) },
				{ expanded: false, isPartial: false },
				theme,
			),
		);
		// Fake-theme markers expose the color decision: reported partial wins.
		expect(text).toContain("[warning]◐ done (report: partial)[/warning]");
		expect(text).not.toContain("[success]✓ done[/success]");
	});

	test("blocked report over a done settle shows the report segment in the error color", () => {
		const text = lines(
			renderSubagentResult(
				{ details: outcome({ status: "done", result: envelope({ status: "blocked" }) }) },
				{ expanded: false, isPartial: false },
				theme,
			),
		);
		expect(text).toContain("[error]✗ done (report: blocked)[/error]");
	});

	test("collapsed summary is capped", () => {
		const long = outcome({ result: envelope({ summary: "y".repeat(400) }) });
		const summaryLine = renderLines(renderSubagentResult({ details: long }, { expanded: false, isPartial: false }, theme))
			.find((l) => l.includes("yyy"));
		expect(summaryLine?.trim()).toBeDefined();
		expect(summaryLine!.trim().length).toBeLessThan(300);
		expect(summaryLine!.trim().endsWith("…")).toBe(true);
	});

	test("expanded reveals check lines, cwd, gaps, contract conflicts, full scope", () => {
		const text = lines(renderSubagentResult({ details: outcome() }, { expanded: true, isPartial: false }, theme));
		expect(text).toContain("✓ bun test extensions/subagents/");
		expect(text).toContain("✗ repo-root bun test");
		expect(text).toContain("· /repo");
		expect(text).toContain("scope: extensions/subagents/render.ts");
		expect(text).toContain("index.ts");
		expect(text).not.toContain("+1 more");
		expect(text).not.toContain("to expand");
		const withExtras = outcome({
			result: envelope({
				verification: [...envelope().verification, { check: "blocked check", result: "blocked" as const }],
			}),
			git_facts: { branch: "b", headSha: "abc", dirty: { staged: ["a.ts"], unstaged: ["b.ts"] } },
			last_output: "z".repeat(500),
		});
		const full = lines(renderSubagentResult({ details: withExtras }, { expanded: true, isPartial: false }, theme));
		expect(full).toContain("[warning]○ blocked check[/warning]");
		expect(full).toContain("gaps: README section pending");
		expect(full).toContain("contract conflicts: spec asked for width-capped header");
		expect(full).toContain("staged: a.ts");
		expect(full).toContain("unstaged: b.ts");
	});

	test("reason, mutation warning, and not-dispatched render with their own emphasis", () => {
		const text = lines(
			renderSubagentResult(
				{
					details: outcome({
						status: "blocked",
						result: undefined,
						reason: "deadline fired before report",
						child_may_have_mutated_repo: true,
						dispatched: false,
					}),
				},
				{ expanded: false, isPartial: false },
				theme,
			),
		);
		expect(text).toContain("[error]✗ blocked[/error]");
		expect(text).toContain("reason: deadline fired before report");
		expect(text).toContain("child may have mutated the repo after its last report");
		expect(text).toContain("not dispatched");
	});

	test("needs_input card shows question, respond hint, and deadline", () => {
		const text = lines(
			renderSubagentResult(
				{
					details: outcome({
						status: "needs_input",
						result: undefined,
						question: "Which base branch should I use?",
						deadlineMsLeft: 125000,
					}),
				},
				{ expanded: false, isPartial: false },
				theme,
			),
		);
		expect(text).toContain("[warning]? needs_input[/warning]");
		expect(text).toContain("question: Which base branch should I use?");
		expect(text).toContain("answer via subagent op=respond id=sa-2-ve6z");
		expect(text).toContain("deadline 2m5s");
	});

	test("running card with detached HEAD shows the accent glyph and dim (detached)", () => {
		const text = lines(
			renderSubagentResult(
				{
					details: outcome({
						status: "running",
						result: undefined,
						git_facts: { branch: "", headSha: "deadbeef123", dirty: { staged: [], unstaged: [] } },
					}),
				},
				{ expanded: false, isPartial: false },
				theme,
			),
		);
		expect(text).toContain("[accent]● running[/accent]");
		expect(text).toContain("(detached)");
		expect(text).not.toContain(" @ ");
	});
});
