/**
 * TUI rendering for the task-workspace tools (`task_status`,
 * `ensure_task_repo`, `remove_task_lane`, `checkpoint_commit`): one-line call
 * previews and compact result cards. Display-only — execute() return values
 * (content and details) are never touched; these functions only shape what
 * the transcript shows.
 *
 * Result shapes are detected structurally from the `details` attachment
 * (see detailsFor in ./index.ts); anything unknown falls through as
 * sanitized text. Sanitizing mirrors todo/render.ts and subagents/render.ts:
 * control sequences stripped and tabs expanded at every render boundary.
 */

import { Text, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { DirtyState } from "./types.ts";

/** Task-key cap in the task_status rows (chars). */
const KEY_CAP = 34;
/** Call-line message preview cap (chars). */
const MESSAGE_PREVIEW_CAP = 60;
/** Deferred-hook remaining_gap cap on the checkpoint_commit card (chars). */
const REMAINING_GAP_CAP = 120;
/** Call-line meta cap (chars) — renderCall receives no terminal width. */
const META_CAP = 160;
/** Row width cap (chars) — renderResult receives no terminal width. */
const ROW_CAP = 400;

function forDisplay(text: string): string {
	return stripTerminalSequences(text).replace(/\t/g, "  ");
}

function capChars(text: string, cap: number): string {
	return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

function sha7(sha: string): string {
	return sha.slice(0, 7);
}

function dot(theme: Theme): string {
	return theme.fg("dim", " · ");
}

function cardText(lines: string[]): Component {
	return new Text(lines.join("\n"), 0, 0);
}

function callLine(name: string, meta: string, theme: Theme): Component {
	const suffix = meta ? ` ${theme.fg("muted", truncateToWidth(meta, META_CAP))}` : "";
	return new Text(`${theme.fg("toolTitle", theme.bold(name))}${suffix}`, 0, 0);
}

/** One-line card. */
function oneLine(segments: string[], theme: Theme): Component {
	return cardText([truncateToWidth(segments.join(dot(theme)), ROW_CAP)]);
}

export interface ToolResultLike {
	content?: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
}

export interface RenderOptions {
	expanded: boolean;
	isPartial: boolean;
}

function firstText(result: ToolResultLike): string {
	return result.content?.find((c) => c.type === "text")?.text ?? "";
}

/** Shared error and live-partial preamble; undefined = keep rendering. */
function errorOrPartial(result: ToolResultLike, options: RenderOptions, theme: Theme, fallback: string): Component | undefined {
	if (result.isError) {
		const text = firstText(result) || fallback;
		return cardText([theme.fg("error", `✗ ${forDisplay(text)}`)]);
	}
	if (options.isPartial) {
		return cardText([theme.fg("dim", forDisplay(firstText(result)))]);
	}
	return undefined;
}

/** Unknown-shape fallthrough: sanitized verbatim text. */
function passthrough(result: ToolResultLike, theme: Theme): Component {
	return cardText([theme.fg("dim", forDisplay(firstText(result)))]);
}

// ============================================================ task_status

export interface TaskWorkspaceRepoLike {
	name: string;
	path: string;
	kind: "canonical" | "lane";
	slot: string | null;
	branch: string;
	headSha: string;
	upstream: string | null;
	dirty: DirtyState;
	/** Cross-process ownership: who currently holds the right to write. */
	owner?: {
		state: string;
		holder?: {
			agentId?: string;
			processes: { pid: number; role: string; alive: boolean }[];
		};
	};
}

export interface TaskWorkspaceLike {
	workspace: string;
	key: string;
	task: string;
	repos: TaskWorkspaceRepoLike[];
	artifacts: string[];
}

export interface TaskStatusDetailsLike {
	classification?: string;
	cwd?: string;
	repoRoot?: string;
	branch?: string;
	isLinkedWorktree?: boolean;
	taskRoot?: string;
	taskWorkspaces?: TaskWorkspaceLike[];
}

export interface TaskStatusResultLike extends ToolResultLike {
	details?: TaskStatusDetailsLike;
}

/** Structural detection: a classification string plus a workspace list. */
function asTaskStatusDetails(value: unknown): TaskStatusDetailsLike | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const v = value as Record<string, unknown>;
	if (typeof v.classification !== "string") return undefined;
	if (!Array.isArray(v.taskWorkspaces)) return undefined;
	return v as unknown as TaskStatusDetailsLike;
}

/** `clean` or `dirty: N staged, M unstaged` (zero counts omitted). */
function dirtyText(dirty: DirtyState): string {
	const parts: string[] = [];
	if (dirty.staged.length > 0) parts.push(`${dirty.staged.length} staged`);
	if (dirty.unstaged.length > 0) parts.push(`${dirty.unstaged.length} unstaged`);
	return parts.length > 0 ? `dirty: ${parts.join(", ")}` : "clean";
}

/** `owner: <agentId|pid> (parent|child)` or the non-live ownership state. */
function ownerText(owner: NonNullable<TaskWorkspaceRepoLike["owner"]>, theme: Theme): string {
	if (owner.state !== "owned") return theme.fg("warning", `owner: ${forDisplay(owner.state)}`);
	const live = (owner.holder?.processes ?? []).find((p) => p.alive);
	const who = owner.holder?.agentId ?? (live ? `pid ${live.pid}` : "live");
	return theme.fg("warning", `owner: ${forDisplay(who)}${live ? ` (${forDisplay(live.role)})` : ""}`);
}

function repoRow(repo: TaskWorkspaceRepoLike, taskKey: string, theme: Theme): string {
	const segments: string[] = [];
	if (repo.kind === "lane") {
		segments.push(theme.fg("dim", repo.slot ? `↳ ${forDisplay(repo.slot)}` : "↳ lane"));
	} else {
		segments.push(capChars(forDisplay(taskKey), KEY_CAP));
	}
	segments.push(forDisplay(repo.name));
	segments.push(
		repo.branch
			? theme.fg("muted", `${forDisplay(repo.branch)} @ ${sha7(repo.headSha)}`)
			: theme.fg("dim", "(detached)"),
	);
	segments.push(
		repo.upstream
			? theme.fg("dim", `↑ ${forDisplay(repo.upstream)}`)
			: theme.fg("dim", "no upstream"),
	);
	const dirty = dirtyText(repo.dirty);
	segments.push(dirty === "clean" ? theme.fg("dim", dirty) : theme.fg("warning", dirty));
	if (repo.owner && repo.owner.state !== "free") {
		segments.push(ownerText(repo.owner, theme));
	}
	return truncateToWidth(segments.join(dot(theme)), ROW_CAP);
}

export function renderTaskStatusCall(args: { path?: string }, theme: Theme): Component {
	return callLine("task_status", args.path ? forDisplay(args.path) : "", theme);
}

export function renderTaskStatusResult(
	result: TaskStatusResultLike,
	options: RenderOptions,
	theme: Theme,
): Component {
	const early = errorOrPartial(result, options, theme, "task_status failed");
	if (early) return early;

	const details = asTaskStatusDetails(result.details);
	if (!details) return passthrough(result, theme);

	// Header: `Task Status` · classification · git segment · N workspaces.
	// The details payload carries no top-level HEAD sha, so the git segment
	// is branch-only (rows show each managed repo's sha).
	const segments: string[] = [
		theme.fg("toolTitle", theme.bold("Task Status")),
		theme.fg("muted", forDisplay(details.classification ?? "")),
	];
	if (details.classification !== "OUTSIDE_GIT") {
		if (details.branch) {
			segments.push(theme.fg("muted", forDisplay(details.branch)));
		} else if (details.repoRoot) {
			segments.push(theme.fg("dim", "(detached)"));
		}
	}
	const workspaces = details.taskWorkspaces ?? [];
	const n = workspaces.length;
	segments.push(theme.fg("dim", n === 1 ? "1 workspace" : `${n} workspaces`));

	const lines = [truncateToWidth(segments.join(dot(theme)), ROW_CAP)];

	if (workspaces.length === 0) {
		lines.push(theme.fg("dim", "no managed task workspaces"));
		return cardText(lines);
	}
	for (const ws of workspaces) {
		if (options.expanded) lines.push(theme.fg("dim", forDisplay(ws.workspace)));
		for (const repo of ws.repos ?? []) {
			lines.push(repoRow(repo, ws.key ?? "", theme));
			if (options.expanded) lines.push(theme.fg("dim", `  ${forDisplay(repo.path)}`));
		}
		if (options.expanded) {
			for (const artifact of ws.artifacts ?? []) {
				lines.push(theme.fg("dim", `artifact: ${forDisplay(artifact)}`));
			}
		}
	}
	return cardText(lines);
}

// ======================================================== ensure_task_repo

export function renderEnsureTaskRepoCall(
	args: { branch?: string; slot?: string },
	theme: Theme,
): Component {
	const parts: string[] = [];
	if (args.branch) parts.push(`branch=${forDisplay(args.branch)}`);
	if (args.slot) parts.push(`slot=${forDisplay(args.slot)}`);
	return callLine("ensure_task_repo", parts.join(" · "), theme);
}

export function renderEnsureTaskRepoResult(
	result: ToolResultLike,
	options: RenderOptions,
	theme: Theme,
): Component {
	const early = errorOrPartial(result, options, theme, "ensure_task_repo failed");
	if (early) return early;

	const v = result.details;
	if (typeof v === "object" && v !== null) {
		const d = v as Record<string, unknown>;
		if (typeof d.status === "string" && typeof d.worktree === "string") {
			const segments = [
				theme.fg("success", `✓ ${d.status}`),
				theme.fg("muted", forDisplay(d.worktree)),
			];
			if (typeof d.branch === "string" && d.branch) {
				segments.push(theme.fg("dim", forDisplay(d.branch)));
			}
			if (typeof d.base === "object" && d.base !== null) {
				const base = d.base as { ref?: unknown };
				if (typeof base.ref === "string" && base.ref) {
					segments.push(theme.fg("dim", `base ${forDisplay(base.ref)}`));
				}
			}
			return oneLine(segments, theme);
		}
	}
	return passthrough(result, theme);
}

// ======================================================= remove_task_lane

export function renderRemoveTaskLaneCall(
	args: { task?: string; path?: string },
	theme: Theme,
): Component {
	const parts: string[] = [];
	if (args.task) parts.push(`task=${forDisplay(args.task)}`);
	if (args.path) parts.push(forDisplay(args.path));
	return callLine("remove_task_lane", parts.join(" · "), theme);
}

export function renderRemoveTaskLaneResult(
	result: ToolResultLike,
	options: RenderOptions,
	theme: Theme,
): Component {
	const early = errorOrPartial(result, options, theme, "remove_task_lane failed");
	if (early) return early;

	const v = result.details;
	if (typeof v === "object" && v !== null) {
		const d = v as Record<string, unknown>;
		if (d.status === "removed") {
			const segments = [theme.fg("success", "✓ removed")];
			if (typeof d.task === "string" && d.task) segments.push(theme.fg("muted", forDisplay(d.task)));
			if (typeof d.repo === "string" && d.repo) {
				const lane = typeof d.slot === "string" && d.slot ? `${d.repo}__${forDisplay(d.slot)}` : d.repo;
				segments.push(theme.fg("muted", forDisplay(lane)));
			}
			if (typeof d.branch === "string" && d.branch) {
				const sha = typeof d.headSha === "string" ? ` @ ${sha7(d.headSha)}` : "";
				segments.push(theme.fg("muted", `${forDisplay(d.branch)}${sha}`));
			}
			return oneLine(segments, theme);
		}
	}
	return passthrough(result, theme);
}

// ======================================================= teardown_task_repo

export function renderTeardownTaskRepoCall(
	args: { task?: string },
	theme: Theme,
): Component {
	return callLine("teardown_task_repo", args.task ? forDisplay(args.task) : "", theme);
}

export function renderTeardownTaskRepoResult(
	result: ToolResultLike,
	options: RenderOptions,
	theme: Theme,
): Component {
	const early = errorOrPartial(result, options, theme, "teardown_task_repo failed");
	if (early) return early;

	const v = result.details;
	if (typeof v === "object" && v !== null) {
		const d = v as Record<string, unknown>;
		if (d.status === "torn_down") {
			const segments = [theme.fg("success", "✓ torn down")];
			if (typeof d.task === "string" && d.task) segments.push(theme.fg("muted", forDisplay(d.task)));
			const repos = Array.isArray(d.repos) ? d.repos.length : 0;
			segments.push(theme.fg("dim", `${repos} ${repos === 1 ? "repo" : "repos"}`));
			return oneLine(segments, theme);
		}
	}
	return passthrough(result, theme);
}

// ======================================================= checkpoint_commit

export function renderCheckpointCommitCall(
	args: { repo?: string; message?: string },
	theme: Theme,
): Component {
	const parts: string[] = [];
	if (args.repo) parts.push(forDisplay(args.repo));
	if (args.message) {
		parts.push(capChars(forDisplay(args.message.replace(/\s+/g, " ").trim()), MESSAGE_PREVIEW_CAP));
	}
	return callLine("checkpoint_commit", parts.join(" · "), theme);
}

export function renderCheckpointCommitResult(
	result: ToolResultLike,
	options: RenderOptions,
	theme: Theme,
): Component {
	const early = errorOrPartial(result, options, theme, "checkpoint_commit failed");
	if (early) return early;

	const v = result.details;
	if (typeof v === "object" && v !== null) {
		const d = v as Record<string, unknown>;
		const commitSha = typeof d.commit === "string" && d.commit ? sha7(d.commit) : "";
		if (d.status === "committed" && commitSha) {
			const segments = [theme.fg("success", `✓ ${commitSha}`)];
			if (typeof d.branch === "string" && d.branch) {
				segments.push(theme.fg("muted", forDisplay(d.branch)));
			}
			const files = Array.isArray(d.files) ? d.files.length : 0;
			segments.push(theme.fg("dim", `${files} ${files === 1 ? "file" : "files"}`));
			return oneLine(segments, theme);
		}
		if (d.status === "committed_with_deferred_hook" && commitSha) {
			const segments = [theme.fg("success", `✓ ${commitSha}`), theme.fg("warning", "deferred hook verification")];
			if (typeof d.remaining_gap === "string" && d.remaining_gap) {
				segments.push(capChars(forDisplay(d.remaining_gap), REMAINING_GAP_CAP));
			}
			return oneLine(segments, theme);
		}
	}
	return passthrough(result, theme);
}
