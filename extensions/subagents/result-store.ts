/**
 * Result persistence for subagents.
 *
 * One JSON file per agent under the pi agent dir
 * (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`) at `subagents/results/`.
 * Runtime artifacts stay out of the user's working repository. Files are
 * written when an agent reaches a terminal state and read lazily by
 * `subagent result`. The main agent's context never receives this payload
 * automatically.
 *
 * Layout: a result carrying `parentSession` lives at
 * `<resultsDir>/by-session/<key>/<sanitizedId>.json`, where `<key>` is
 * {@link sessionKey}: the first 32 lowercase hex chars of the SHA-256 of the
 * exact `parentSession` string (UTF-8). This derivation is a cross-repo
 * contract (ZAVOD computes the same key to read one session's results
 * without scanning other sessions' files); do not change it. Results without
 * `parentSession`, and results written before this layout, live flat at
 * `<resultsDir>/<sanitizedId>.json`. Readers look at the legacy flat file
 * FIRST and fall back to the per-session directories: while a flat file and
 * a per-session copy of the same id coexist, the flat file is a legacy
 * writer's re-write that landed AFTER the copy was migrated — the legacy
 * writer only ever moves a record forward, so the flat record is the newer
 * state. {@link migrateLegacyResults} relocates flat files that carry
 * `parentSession`, upgrading an already-migrated snapshot to the legacy
 * writer's latest state instead of skipping it.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentResult } from "./types";
import { validateLastAssistantText } from "./last-text";

/** The fs surface this module touches. Injectable so the race windows
 * (another process publishing between two of these calls) can be produced
 * deterministically in tests; production callers use the default. */
export type ResultStoreIo = Pick<
	typeof fs,
	"readdirSync" | "readFileSync" | "statSync" | "mkdirSync" | "writeFileSync" | "renameSync" | "unlinkSync"
>;

export function defaultResultsDir(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "subagents", "results");
}

/** Directory name for one parent session: first 32 hex chars of SHA-256(parentSession, UTF-8). */
export function sessionKey(parentSession: string): string {
	return createHash("sha256").update(parentSession, "utf8").digest("hex").slice(0, 32);
}

function sessionDir(dir: string, parentSession: string): string {
	return path.join(dir, "by-session", sessionKey(parentSession));
}

export function saveResult(result: AgentResult, dir: string): string {
	const target = result.parentSession ? sessionDir(dir, result.parentSession) : dir;
	fs.mkdirSync(target, { recursive: true });
	const file = path.join(target, `${sanitizeId(result.id)}.json`);
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(result, null, "\t"), "utf8");
	fs.renameSync(tmp, file);
	return file;
}

/**
 * Load one persisted result. Terminal records written by earlier sessions
 * are the source for `subagent result` after a main restart, so the optional
 * bounded channel gets a read-time boundary here: a malformed
 * `lastAssistantText` is dropped, never forwarded into live projections;
 * every other persisted fact passes through untouched and the file itself
 * is never rewritten (old/legacy records stay as written).
 */
export function loadResult(agentId: string, dir: string, io: ResultStoreIo = fs): AgentResult | null {
	const name = `${sanitizeId(agentId)}.json`;
	// Flat first: a legacy re-write is the newer state while it exists (see
	// the layout note above). The parent session is unknown to the caller, so
	// every per-session directory is checked afterwards. A concurrent
	// migration can move the file between the flat read and the per-session
	// listing; a file is moved exactly once, so one retry observes it at its
	// destination instead of reporting the record missing.
	for (let attempt = 0; attempt < 2; attempt++) {
		const flat = readResultFile(path.join(dir, name), io);
		if (flat) return flat;
		for (const base of sessionDirs(dir, io)) {
			const found = readResultFile(path.join(base, name), io);
			if (found) return found;
		}
	}
	return null;
}

function sessionDirs(dir: string, io: ResultStoreIo = fs): string[] {
	try {
		return (io.readdirSync(path.join(dir, "by-session"), { withFileTypes: true }) as fs.Dirent[])
			.filter((e) => e.isDirectory())
			.map((e) => path.join(dir, "by-session", e.name));
	} catch {
		return [];
	}
}

function readResultFile(file: string, io: ResultStoreIo = fs): AgentResult | null {
	try {
		const parsed: unknown = JSON.parse(io.readFileSync(file, "utf8"));
		if (!parsed || typeof parsed !== "object") return null;
		const record = parsed as AgentResult & { lastAssistantText?: unknown };
		const bounded = validateLastAssistantText(record.lastAssistantText);
		if (bounded) return { ...record, lastAssistantText: bounded };
		const { lastAssistantText: _malformed, ...rest } = record;
		return rest;
	} catch {
		return null;
	}
}

/**
 * Sum persisted subagent spend attributed to one parent session
 * (`result.parentSession === parentSession`). Used to reconstruct a
 * session's subagent cost after a resume, when the in-memory runtime is
 * gone and only the result files remain. Unreadable entries contribute
 * nothing.
 */
export function sumSessionCost(dir: string, parentSession: string, io: ResultStoreIo = fs): number {
	let total = 0;
	for (const result of listResults([dir, sessionDir(dir, parentSession)], io)) {
		if (result.parentSession === parentSession) total += result.tokens?.cost ?? 0;
	}
	return total;
}

/**
 * Parse `.json` files from the given directories in order (the legacy flat
 * one first, per-session directories after: a legacy re-write is the newer
 * state while it exists). A file name already seen in an earlier directory
 * is skipped, so a result present in two places is never counted twice, and
 * a file that failed to parse does not block a readable copy in a later
 * directory. Unreadable, partial or non-object files are skipped; `.tmp`
 * files from `saveResult` are excluded by the extension filter.
 *
 * The sweep runs TWICE. A concurrent migration can move a file between the
 * flat and per-session listings — or a legacy writer can deliver a terminal
 * file mid-sweep — and the first pass would then miss the name in both
 * places. A file is moved exactly once, so the second pass observes every
 * name that existed when it began; names already seen are skipped, so the
 * second pass adds only what the first one lost.
 */
function listResults(bases: string[], io: ResultStoreIo = fs): AgentResult[] {
	const seen = new Set<string>();
	const out: AgentResult[] = [];
	const sweep = (): void => {
		for (const base of bases) {
			let entries: string[];
			try {
				entries = io.readdirSync(base) as string[];
			} catch {
				continue;
			}
			for (const name of entries) {
				if (!name.endsWith(".json") || seen.has(name)) continue;
				try {
					const parsed = JSON.parse(io.readFileSync(path.join(base, name), "utf8")) as AgentResult;
					if (!parsed || typeof parsed !== "object") continue;
					seen.add(name);
					out.push(parsed);
				} catch {
					// corrupt/partial file: skip, never break the rollup
				}
			}
		}
	};
	sweep();
	sweep();
	return out;
}

/** Every parsed result in the store: the legacy flat directory first, then all per-session ones. */
export function listAllResults(dir: string, io: ResultStoreIo = fs): AgentResult[] {
	return listResults([dir, ...sessionDirs(dir, io)], io);
}

/** dev/ino/mtime identity of a path: the legacy writer publishes by rename
 * (a fresh inode) and nothing rewrites a published file in place, so equal
 * identity means the bytes read are still the bytes at that path. */
function statIdentity(file: string, io: ResultStoreIo): { dev: bigint; ino: bigint; mtimeNs: bigint } | null {
	try {
		const st = io.statSync(file, { bigint: true }) as unknown as { dev: bigint; ino: bigint; mtimeNs: bigint };
		return { dev: st.dev, ino: st.ino, mtimeNs: st.mtimeNs };
	} catch {
		return null;
	}
}

const sameIdentity = (a: { dev: bigint; ino: bigint; mtimeNs: bigint }, b: { dev: bigint; ino: bigint; mtimeNs: bigint }): boolean =>
	a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs;

/**
 * Move legacy flat result files that carry `parentSession` into their
 * per-session directory, and keep an already-migrated snapshot honest
 * while its legacy writer is still alive (an old process keeps publishing
 * to the flat path across an upgrade).
 *
 * Per file, in this order:
 *
 * 1. The content is read against a stable source: if the file's identity
 *    (dev/ino/mtimeNs) changes between the pre-read and post-read stat, it
 *    is re-read \u2014 the writer published mid-read; what is copied is exactly
 *    the state the post-read stat points at.
 * 2. The target is written by tmp+rename \u2014 an atomic REPLACE, not a link
 *    with an EEXIST skip: a migrated copy is only a snapshot, and when the
 *    legacy writer has re-published a newer state (a terminal record after
 *    the snapshotted spawn-time "running" marker), the copy MUST be
 *    upgraded; skipping it would pin the stale marker forever.
 * 3. The source is renamed away to `<name>.migrating` \u2014 atomic against
 *    the writer's own rename: whichever of the two renames lands first, the
 *    other side's state stays visible at one of the two names, so a
 *    publish is never destroyed by the removal. The `.migrating` file is
 *    unlinked only when its identity still equals the snapshot; otherwise
 *    (the writer's newer publish slid into the rename) it is adopted by
 *    the recovery sweep below or the next pass. Readers never list
 *    `.migrating` names, so a stranded newer state waits for a pass
 *    instead of being lost.
 *
 * The recovery sweep at the end adopts `*.json.migrating` leftovers from
 * interrupted passes with the same read/write/unlink discipline. Idempotent
 * and safe across concurrent processes (both writers publish the same
 * bytes; the last rename wins and converges). Unreadable or unparseable
 * files, and files without a string `parentSession` or whose name is not
 * their own sanitized id, stay in place. Never throws. Returns the number
 * of source files this call removed.
 */
export function migrateLegacyResults(dir: string, io: ResultStoreIo = fs): number {
	let moved = 0;
	try {
		for (const name of io.readdirSync(dir) as string[]) {
			if (!name.endsWith(".json")) continue;
			moved += migrateOne(dir, name, path.join(dir, name), io);
		}
	} catch {
		// unreadable directory: nothing to do
	}
	try {
		for (const name of io.readdirSync(dir) as string[]) {
			if (!name.endsWith(".json.migrating")) continue;
			moved += migrateOne(dir, name.slice(0, -".migrating".length), path.join(dir, name), io);
		}
	} catch {
		// unreadable directory: nothing to do
	}
	return moved;
}

/** Migrate one file whose result name is `name`, currently parked at `src`
 * (the flat `<dir>/<name>` or its `.migrating` shadow). Returns 1 when the
 * source was removed. Never throws. */
function migrateOne(dir: string, name: string, src: string, io: ResultStoreIo): number {
	try {
		// Read against a stable source; a file the writer keeps replacing is
		// retried a bounded number of times and otherwise left to the next pass.
		let parsed: Partial<AgentResult> | null = null;
		let snapshot: { dev: bigint; ino: bigint; mtimeNs: bigint } | null = null;
		for (let attempt = 0; attempt < 4; attempt++) {
			const before = statIdentity(src, io);
			if (!before) break; // vanished (another process moved it)
			const read = JSON.parse(io.readFileSync(src, "utf8")) as Partial<AgentResult> | null;
			const after = statIdentity(src, io);
			if (after && sameIdentity(before, after)) {
				parsed = read;
				snapshot = after;
				break;
			}
		}
		if (parsed === null || snapshot === null) return 0;
		if (!parsed || typeof parsed !== "object") return 0;
		if (typeof parsed.id !== "string" || typeof parsed.parentSession !== "string" || !parsed.parentSession) return 0;
		if (`${sanitizeId(parsed.id)}.json` !== name) return 0;
		const target = sessionDir(dir, parsed.parentSession);
		io.mkdirSync(target, { recursive: true });
		const dest = path.join(target, name);
		const tmp = `${dest}.tmp`;
		io.writeFileSync(tmp, JSON.stringify(parsed, null, "\t"), "utf8");
		io.renameSync(tmp, dest);
		// Rename the source away \u2014 atomic against the writer's own publish.
		const trash = `${src}.migrating`;
		try {
			io.renameSync(src, trash);
		} catch {
			return 0; // ENOENT (another process moved it): dest already converged
		}
		// Remove only the exact file that was snapshotted; a newer publish
		// that slid into the rename stays parked at the trash name for the
		// recovery sweep of this or a later pass.
		const parked = statIdentity(trash, io);
		if (parked && sameIdentity(parked, snapshot)) {
			try {
				io.unlinkSync(trash);
				return 1;
			} catch {
				return 0;
			}
		}
		return 0;
	} catch {
		// ENOENT (moved by another process), unreadable or unparseable: leave as is
		return 0;
	}
}

/** Derive a one-line summary from the child's final assistant text. */
export function summarizeText(finalText: string | undefined, max = 240): string {
	if (!finalText) return "(no final text)";
	const flat = finalText
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.join(" · ");
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function sanitizeId(id: string): string {
	return id.replace(/[^A-Za-z0-9._-]+/g, "_");
}
