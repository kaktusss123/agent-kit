/**
 * update-check — pure decision logic for the agent-kit update notification.
 *
 * The extension physically lives in the active checkout (agent-kit symlinks
 * the extension tree into ~/.pi/agent), so "what would `agent-kit update`
 * bring" is defined by the checkout's own upstream. A small JSON cache in
 * the agent-kit state dir throttles the network check (one `git ls-remote`
 * per interval per machine at most) and lets the toast repeat on every
 * session start while the checkout is behind — with no network on those
 * starts. After a successful `agent-kit update` the moved local HEAD makes
 * decide() fall through to a fresh network check instead of toasting stale
 * news.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Re-check the network at most this often while the cache says up to date. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdateStatus = "up-to-date" | "outdated";

export interface UpdateState {
	/** Cache format version. */
	v: 1;
	/** Epoch ms of the last successful network check. */
	lastCheck: number;
	status: UpdateStatus;
	/** Local HEAD at check time; present when outdated. */
	head?: string;
	/** Upstream SHA at check time; present when outdated. */
	remote?: string;
	/** "<remote>/<branch>" of the checkout's upstream; present when outdated. */
	upstream?: string;
}

export function readUpdateState(file: string): UpdateState | null {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as UpdateState;
		if (parsed?.v !== 1) return null;
		if (parsed.status !== "up-to-date" && parsed.status !== "outdated") return null;
		if (typeof parsed.lastCheck !== "number" || !Number.isFinite(parsed.lastCheck)) return null;
		return parsed;
	} catch {
		return null;
	}
}

export function writeUpdateState(file: string, state: UpdateState): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(state)}\n`);
	renameSync(tmp, file);
}

export type Decision =
	| { action: "notify" } // cached outdated, still true locally: toast now, no network
	| { action: "check" } // run the network check
	| { action: "skip" }; // fresh up-to-date cache: stay silent

export function decide(
	state: UpdateState | null,
	localHead: string | null,
	now: number,
	interval: number = CHECK_INTERVAL_MS,
): Decision {
	// No readable HEAD: nothing meaningful to compare — stay silent.
	if (localHead === null) return { action: "skip" };
	if (state?.status === "outdated") {
		// Local HEAD moved since the check (agent-kit update ran): re-evaluate.
		if (state.head !== undefined && state.head !== localHead) return { action: "check" };
		// HEAD now matches the previously seen upstream: quietly refreshed.
		if (state.remote !== undefined && state.remote === localHead) return { action: "skip" };
		return { action: "notify" };
	}
	if (!state || now - state.lastCheck >= interval) return { action: "check" };
	return { action: "skip" };
}

/** First SHA from `git ls-remote <remote> <ref>` output, or null. */
export function parseLsRemote(stdout: string): string | null {
	const line = stdout.split("\n").find((l) => l.trim().length > 0);
	if (!line) return null;
	const sha = line.split("\t")[0]?.trim() ?? "";
	return /^[0-9a-f]{40,}$/i.test(sha) ? sha : null;
}

export function updateMessage(upstream?: string): string {
	const where = upstream ? ` (behind ${upstream})` : "";
	return `agent-kit: update available${where} — run 'agent-kit update'`;
}

/** Reminder for an active checkout left on a non-default branch: names the
 *  branch and gives the exact switch-back-and-update command. */
export function offMainMessage(branch: string, def: string, repo: string): string {
	return `agent-kit: active checkout is on '${branch}', not ${def} — run: git -C ${repo} switch ${def} && agent-kit update`;
}
