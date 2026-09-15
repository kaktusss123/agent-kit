import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { DirtyState } from "./types";
import {
	renderCheckpointCommitCall,
	renderCheckpointCommitResult,
	renderEnsureTaskRepoCall,
	renderEnsureTaskRepoResult,
	renderRemoveTaskLaneCall,
	renderRemoveTaskLaneResult,
	renderTaskStatusCall,
	renderTaskStatusResult,
	type TaskStatusResultLike,
	type ToolResultLike,
} from "./render";

/** Plain-text fake theme: assertions read like `[accent]…[/accent]`. */
function fakeTheme(): Theme {
	const wrap = (color: string) => (text: string) => `[${color}]${text}[/${color}]`;
	return {
		fg: (color, text) => wrap(color)(text),
		bold: (text: string) => `**${text}**`,
	} as unknown as Theme;
}

const theme = fakeTheme();

/** Strip real ANSI escapes before asserting on render(width) output. */
function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function lines(component: { render: (width: number) => string[] }): string {
	return stripAnsi(component.render(400).join("\n"));
}

/** Fake-theme markers removed too — for assertions spanning styled segments. */
function plain(component: { render: (width: number) => string[] }): string {
	return lines(component)
		.replace(/\[\/?[a-zA-Z]+\]/g, "")
		.replace(/\*\*/g, "");
}

const NO_OPTIONS = { expanded: false, isPartial: false };
const EXPANDED = { expanded: true, isPartial: false };

function textResult(text: string): ToolResultLike {
	return { content: [{ type: "text", text }] };
}

function dirty(staged: number, unstaged: number): DirtyState {
	return {
		staged: Array.from({ length: staged }, (_, i) => `s${i}.ts`),
		unstaged: Array.from({ length: unstaged }, (_, i) => `u${i}.ts`),
	};
}

function repo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: "agent-kit",
		path: "/home/v/.agent-kit/tasks/feat_x/agent-kit",
		kind: "canonical",
		slot: null,
		classification: "MANAGED_TASK_WORKTREE",
		branch: "feat/x",
		headSha: "5728b58abc1234",
		upstream: "origin/feat/x",
		dirty: dirty(0, 0),
		...overrides,
	};
}

function statusDetails(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		classification: "MANAGED_TASK_WORKTREE",
		cwd: "/home/v/.agent-kit/tasks/feat_x/agent-kit",
		repoRoot: "/home/v/.agent-kit/tasks/feat_x/agent-kit",
		branch: "feat/x",
		isLinkedWorktree: true,
		taskRoot: "/home/v/.agent-kit/tasks",
		taskWorkspaces: [],
		...overrides,
	};
}

function statusResult(details: Record<string, unknown>): TaskStatusResultLike {
	return { content: [{ type: "text", text: "{}" }], details } as unknown as TaskStatusResultLike;
}

describe("renderTaskStatusResult — collapsed card", () => {
	test("header carries title, classification, branch, and workspace count", () => {
		const ws = {
			workspace: "/home/v/.agent-kit/tasks/feat_x",
			key: "feat_x",
			task: "feat_x",
			repos: [repo()],
			artifacts: [],
		};
		const out = lines(
			renderTaskStatusResult(statusResult(statusDetails({ taskWorkspaces: [ws] })), NO_OPTIONS, theme),
		);
		expect(out).toContain("**Task Status**");
		expect(out).toContain("[toolTitle]**Task Status**[/toolTitle]");
		expect(out).toContain("MANAGED_TASK_WORKTREE");
		expect(out).toContain("feat/x");
		expect(out).toContain("1 workspace");
		// branch @ sha is muted on repo rows
		expect(out).toContain("[muted]feat/x @ 5728b58[/muted]");
	});

	test("OUTSIDE_GIT omits the git segment entirely", () => {
		const out = lines(
			renderTaskStatusResult(
				statusResult(statusDetails({ classification: "OUTSIDE_GIT", repoRoot: "", branch: "" })),
				NO_OPTIONS,
				theme,
			),
		);
		expect(out).toContain("OUTSIDE_GIT");
		expect(out).not.toContain("(detached)");
		expect(out).not.toContain("feat/x");
	});

	test("empty branch with a repoRoot shows (detached)", () => {
		const out = lines(
			renderTaskStatusResult(statusResult(statusDetails({ branch: "" })), NO_OPTIONS, theme),
		);
		expect(out).toContain("[dim](detached)[/dim]");
	});

	test("empty workspace list renders the no-workspaces line instead of a table", () => {
		const out = lines(renderTaskStatusResult(statusResult(statusDetails()), NO_OPTIONS, theme));
		expect(out).toContain("no managed task workspaces");
		expect(out).not.toContain("no upstream");
		expect(out).toContain("0 workspaces");
	});

	test("canonical and lane rows: key shown once, lane prefixed with ↳ slot", () => {
		const ws = {
			workspace: "/home/v/.agent-kit/tasks/feat_x",
			key: "feat_x",
			task: "feat_x",
			repos: [
				repo(),
				repo({
					name: "agent-kit__develop-backport",
					kind: "lane",
					slot: "develop-backport",
					branch: "develop-backport",
				}),
				repo({ name: "agent-kit__anon", kind: "lane", slot: null, branch: "", upstream: null }),
			],
			artifacts: [],
		};
		const out = plain(
			renderTaskStatusResult(statusResult(statusDetails({ taskWorkspaces: [ws] })), NO_OPTIONS, theme),
		);
		expect(out.match(/feat_x/g)?.length).toBe(1); // key appears only on the canonical row
		expect(out).toContain("agent-kit · ");
		expect(out).toContain("↳ develop-backport");
		expect(out).toContain("↳ lane");
		expect(out).toContain("↑ origin/feat/x");
		expect(out).toContain("no upstream");
	});

	test("long task keys are capped with an ellipsis", () => {
		const longKey = "feat_x".repeat(12);
		const ws = { workspace: "/t/w", key: longKey, task: longKey, repos: [repo()], artifacts: [] };
		const out = lines(
			renderTaskStatusResult(statusResult(statusDetails({ taskWorkspaces: [ws] })), NO_OPTIONS, theme),
		);
		expect(out).toContain("…");
		expect(out).not.toContain(longKey);
	});

	test("clean trees render dim, dirty trees render warning", () => {
		const clean = {
			workspace: "/t/w",
			key: "feat_x",
			task: "feat_x",
			repos: [repo()],
			artifacts: [],
		};
		const dirtyWs = {
			workspace: "/t/w",
			key: "feat_y",
			task: "feat_y",
			repos: [repo({ dirty: dirty(2, 1) })],
			artifacts: [],
		};
		const out = lines(
			renderTaskStatusResult(
				statusResult(statusDetails({ taskWorkspaces: [clean, dirtyWs] })),
				NO_OPTIONS,
				theme,
			),
		);
		expect(out).toContain('[dim]clean[/dim]');
		expect(out).toContain("[warning]dirty: 2 staged, 1 unstaged[/warning]");
	});

	test("collapsed output hides workspace dirs, repo paths, and artifacts", () => {
		const ws = {
			workspace: "/home/v/.agent-kit/tasks/feat_x",
			key: "feat_x",
			task: "feat_x",
			repos: [repo()],
			artifacts: ["notes.md"],
		};
		const out = lines(
			renderTaskStatusResult(statusResult(statusDetails({ taskWorkspaces: [ws] })), NO_OPTIONS, theme),
		);
		expect(out).not.toContain("artifact:");
		expect(out).not.toContain("/home/v/");
	});
});

describe("renderTaskStatusResult — expanded card", () => {
	const ws = {
		workspace: "/home/v/.agent-kit/tasks/feat_x",
		key: "feat_x",
		task: "feat_x",
		repos: [repo()],
		artifacts: ["notes.md", "spec.json"],
	};

	test("expanded shows workspace dir, repo path, and artifact lines", () => {
		const out = lines(
			renderTaskStatusResult(statusResult(statusDetails({ taskWorkspaces: [ws] })), EXPANDED, theme),
		);
		expect(out).toContain("/home/v/.agent-kit/tasks/feat_x");
		expect(out).toContain("/home/v/.agent-kit/tasks/feat_x/agent-kit");
		expect(out).toContain("artifact: notes.md");
		expect(out).toContain("artifact: spec.json");
	});

	test("unknown details shape falls through to sanitized verbatim text", () => {
		const out = lines(
			renderTaskStatusResult({ ...textResult("plain\ttext\x1b[31mred"), details: { nope: 1 } }, NO_OPTIONS, theme),
		);
		expect(out).toContain("plain  textred");
	});

	test("error results render the failure line", () => {
		const out = lines(
			renderTaskStatusResult({ isError: true, content: [{ type: "text", text: "boom" }] }, NO_OPTIONS, theme),
		);
		expect(out).toContain("[error]✗ boom[/error]");
	});
});

describe("renderEnsureTaskRepoResult", () => {
	test("known shape renders the one-liner", () => {
		const out = lines(
			renderEnsureTaskRepoResult(
				{ ...textResult("{}"), details: { status: "reused", worktree: "/t/feat_x/agent-kit" } },
				NO_OPTIONS,
				theme,
			),
		);
		expect(out).toContain("[success]✓ reused[/success]");
		expect(out).toContain("/t/feat_x/agent-kit");
	});

	test("branch and base are appended dim when present in details", () => {
		const out = lines(
			renderEnsureTaskRepoResult(
				{
					...textResult("{}"),
					details: { status: "created", worktree: "/t/feat_x/agent-kit", branch: "feat/x", base: { ref: "main" } },
				},
				NO_OPTIONS,
				theme,
			),
		);
		expect(out).toContain("[dim]feat/x[/dim]");
		expect(out).toContain("[dim]base main[/dim]");
	});

	test("missing or unknown details fall through to verbatim text", () => {
		const raw = '{"status":"error","message":"nope"}';
		expect(lines(renderEnsureTaskRepoResult(textResult(raw), NO_OPTIONS, theme))).toContain(raw);
		expect(
			lines(renderEnsureTaskRepoResult({ ...textResult(raw), details: { status: "weird" } }, NO_OPTIONS, theme)),
		).toContain(raw);
	});

	test("error results render the failure line", () => {
		const out = lines(renderEnsureTaskRepoResult({ isError: true, content: [{ type: "text", text: "boom" }] }, NO_OPTIONS, theme));
		expect(out).toContain("✗ boom");
	});

	test("call preview shows branch and optional slot", () => {
		const withSlot = lines(renderEnsureTaskRepoCall({ branch: "feat/x", slot: "backport" }, theme));
		expect(withSlot).toContain("ensure_task_repo");
		expect(withSlot).toContain("branch=feat/x · slot=backport");
		expect(lines(renderEnsureTaskRepoCall({ branch: "feat/x" }, theme))).toContain("branch=feat/x");
		expect(lines(renderEnsureTaskRepoCall({}, theme))).not.toContain("branch=");
	});
});

describe("renderRemoveTaskLaneResult", () => {
	test("removed lane renders the one-liner with available facts", () => {
		const out = lines(
			renderRemoveTaskLaneResult(
				{
					...textResult("{}"),
					details: {
						status: "removed",
						task: "feat_x",
						repo: "agent-kit",
						slot: "backport",
						path: "/t/feat_x/agent-kit__backport",
						branch: "feat/x-backport",
						headSha: "5728b58abc1234",
						upstream: null,
						dirty: dirty(0, 0),
					},
				},
				NO_OPTIONS,
				theme,
			),
		);
		expect(out).toContain("[success]✓ removed[/success]");
		expect(out).toContain("feat_x");
		expect(out).toContain("agent-kit__backport");
		expect(out).toContain("feat/x-backport @ 5728b58");
	});

	test("missing details fall through to verbatim text; errors render ✗", () => {
		const raw = '{"status":"lane_rejected","reason":"nope"}';
		expect(lines(renderRemoveTaskLaneResult(textResult(raw), NO_OPTIONS, theme))).toContain(raw);
		expect(lines(renderRemoveTaskLaneResult({ isError: true, content: [{ type: "text", text: "boom" }] }, NO_OPTIONS, theme))).toContain(
			"✗ boom",
		);
	});

	test("call preview shows task and lane path", () => {
		const out = lines(renderRemoveTaskLaneCall({ task: "feat_x", path: "/t/feat_x/agent-kit__backport" }, theme));
		expect(out).toContain("remove_task_lane");
		expect(out).toContain("task=feat_x");
		expect(out).toContain("/t/feat_x/agent-kit__backport");
	});
});

describe("renderCheckpointCommitResult", () => {
	test("committed renders sha7, branch, and file count", () => {
		const out = lines(
			renderCheckpointCommitResult(
				{
					...textResult("{}"),
					details: { status: "committed", commit: "5728b58c77b7dda39aece9a5c903268b15c2ce40", branch: "feat/x", files: ["a.ts", "b.ts", "c.ts"] },
				},
				NO_OPTIONS,
				theme,
			),
		);
		expect(out).toContain("[success]✓ 5728b58[/success]");
		expect(out).toContain("feat/x");
		expect(out).toContain("3 files");
	});

	test("committed_with_deferred_hook renders the deferred line with the capped gap", () => {
		const out = lines(
			renderCheckpointCommitResult(
				{
					...textResult("{}"),
					details: {
						status: "committed_with_deferred_hook",
						commit: "5728b58c77b7dda39aece9a5c903268b15c2ce40",
						remaining_gap: "g".repeat(200),
					},
				},
				NO_OPTIONS,
				theme,
			),
		);
		expect(out).toContain("✓ 5728b58");
		expect(out).toContain("deferred hook verification");
		expect(out).toContain("g".repeat(120) + "…");
		expect(out).not.toContain("g".repeat(121));
	});

	test("other shapes fall through to verbatim text; errors render ✗", () => {
		const raw = '{"status":"commit_failed","stderr":"boom"}';
		expect(lines(renderCheckpointCommitResult(textResult(raw), NO_OPTIONS, theme))).toContain(raw);
		expect(lines(renderCheckpointCommitResult({ isError: true, content: [{ type: "text", text: "boom" }] }, NO_OPTIONS, theme))).toContain(
			"✗ boom",
		);
	});

	test("call preview shows repo and a capped message preview", () => {
		const out = lines(
			renderCheckpointCommitCall({ repo: "/t/feat_x/agent-kit", message: `fix: ${"m".repeat(100)}` }, theme),
		);
		expect(out).toContain("checkpoint_commit");
		expect(out).toContain("/t/feat_x/agent-kit");
		expect(out).toContain("fix: " + "m".repeat(55) + "…"); // 60-char cap including the prefix
		expect(out).not.toContain("m".repeat(56) + "…");
	});
});
