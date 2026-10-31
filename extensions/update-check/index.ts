/**
 * update-check — one-shot toasts about the state of the active agent-kit
 * checkout, mirroring pi's own "new version released" notice:
 *
 * - behind its upstream — network check (git ls-remote), throttled and
 *   cached as described below;
 * - left on a non-default branch, e.g. after `agent-kit install` from a
 *   task worktree the user forgot to switch back from — local-only check,
 *   repeats on every session start until the branch is switched back.
 *
 * Contract (best-effort, like session-title): never delays the session,
 * silent on every failure (offline, unreachable remote, non-git checkout).
 * The check runs at most once per CHECK_INTERVAL_MS per machine while the
 * cache says up to date; while outdated, the toast repeats on every
 * session start with no network — decide() only goes back to the network
 * after the local HEAD moved (i.e. after `agent-kit update` ran).
 *
 * `agent-kit update` is the update command the toast names: pull --ff-only
 * in the active checkout plus the usual install reconcile. It is a terminal
 * command, not an in-pi action — the bash git guard may block mutating git
 * aimed at the primary checkout from pi sessions, and that is fine.
 */

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	decide,
	offMainMessage,
	parseLsRemote,
	readUpdateState,
	updateMessage,
	writeUpdateState,
	type UpdateState,
} from "./check.ts";

const pexecFile = promisify(execFile);

const LOCAL_TIMEOUT_MS = 5_000;
const NETWORK_TIMEOUT_MS = 10_000;

function stateFile(): string {
	const xdg = process.env.XDG_STATE_HOME?.trim();
	const stateHome = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "state");
	return join(stateHome, "agent-kit", "update-check.json");
}

/** The checkout this extension file physically lives in: agent-kit symlinks
 *  <checkout>/extensions/update-check into the Pi agent dir, so three
 *  dirnames up from the real path of this file is the checkout root. */
export function findCheckout(startFile: string): string | null {
	try {
		return join(realpathSync(startFile), "..", "..", "..");
	} catch {
		return null;
	}
}

async function git(repo: string, args: string[], timeoutMs: number): Promise<string | null> {
	try {
		const { stdout } = await pexecFile("git", ["-C", repo, ...args], {
			timeout: timeoutMs,
			windowsHide: true,
		});
		return stdout;
	} catch {
		return null;
	}
}

async function upstreamOf(
	repo: string,
): Promise<{ remote: string; ref: string; name: string } | null> {
	const out = await git(
		repo,
		["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
		LOCAL_TIMEOUT_MS,
	);
	const name = out?.trim();
	const slash = name ? name.indexOf("/") : -1;
	if (!name || slash <= 0) return null;
	return { remote: name.slice(0, slash), ref: name.slice(slash + 1), name };
}

export interface CheckOutcome {
	/** A network check happened. */
	ran: boolean;
	/** The checkout is behind its upstream. */
	outdated: boolean;
	/** A toast was shown for it. */
	notified: boolean;
}

/** Full flow; exported for tests. `repo` is the active checkout. */
export async function runUpdateCheck(
	repo: string,
	opts: {
		file: string;
		now: () => number;
		notify: (message: string) => void;
		interval?: number;
	},
): Promise<CheckOutcome> {
	const outcome: CheckOutcome = { ran: false, outdated: false, notified: false };
	const state: UpdateState | null = readUpdateState(opts.file);
	const head = (await git(repo, ["rev-parse", "HEAD"], LOCAL_TIMEOUT_MS))?.split("\n")[0]?.trim() ?? null;
	const decision = decide(state, head, opts.now(), opts.interval);

	if (decision.action === "skip") return outcome;

	if (decision.action === "notify") {
		opts.notify(updateMessage(state?.upstream));
		outcome.outdated = true;
		outcome.notified = true;
		return outcome;
	}

	outcome.ran = true;
	const up = await upstreamOf(repo);
	if (!up) return outcome; // detached HEAD or no upstream: nothing to compare
	const lsOut = await git(repo, ["ls-remote", up.remote, `refs/heads/${up.ref}`], NETWORK_TIMEOUT_MS);
	const remote = lsOut === null ? null : parseLsRemote(lsOut);
	if (remote === null || head === null) return outcome; // unreachable remote or vanished branch: silent

	if (remote === head) {
		writeUpdateState(opts.file, { v: 1, lastCheck: opts.now(), status: "up-to-date" });
		return outcome;
	}
	const next: UpdateState = {
		v: 1,
		lastCheck: opts.now(),
		status: "outdated",
		head,
		remote,
		upstream: up.name,
	};
	writeUpdateState(opts.file, next);
	opts.notify(updateMessage(up.name));
	outcome.outdated = true;
	outcome.notified = true;
	return outcome;
}

/** Reminder when the active checkout sits on a non-default branch — e.g.
 *  after `agent-kit install` from a task worktree the user forgot to switch
 *  back. Local-only (no network), so it can repeat on every session start.
 *  Returns true when a reminder was shown. */
export async function runOffMainCheck(
	repo: string,
	notify: (message: string) => void,
): Promise<boolean> {
	const branch = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"], LOCAL_TIMEOUT_MS))?.trim();
	if (!branch || branch === "HEAD") return false; // detached HEAD: out of scope
	const ref = (
		await git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], LOCAL_TIMEOUT_MS)
	)?.trim();
	const slash = ref ? ref.indexOf("/") : -1;
	if (!ref || slash <= 0) return false; // default branch unknown: stay silent
	const def = ref.slice(slash + 1);
	if (branch === def) return false;
	notify(offMainMessage(branch, def, repo));
	return true;
}

export default function updateCheckExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return; // fire-and-forget toasts only where a UI exists
		const repo = findCheckout(fileURLToPath(import.meta.url));
		if (repo === null) return;
		// Fire-and-forget: session_start must never wait on git or the network.
		void runOffMainCheck(repo, (message) => ctx.ui.notify(message, "warning")).catch(() => {});
		void runUpdateCheck(repo, {
			file: stateFile(),
			now: () => Date.now(),
			notify: (message) => ctx.ui.notify(message, "warning"),
		}).catch(() => {});
	});
}
