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
	"readdirSync" | "readFileSync" | "statSync" | "mkdirSync" | "writeFileSync" | "renameSync" | "unlinkSync" | "openSync" | "closeSync" | "writeSync"
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
	for (const result of listResults(() => [dir, sessionDir(dir, parentSession)], io)) {
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
function listResults(basesOf: () => string[], io: ResultStoreIo = fs): AgentResult[] {
	const seen = new Set<string>();
	const out: AgentResult[] = [];
	const sweep = (): void => {
		for (const base of basesOf()) {
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
	return listResults(() => [dir, ...sessionDirs(dir, io)], io);
}

/** dev/ino/mtime identity of a path: the legacy writer publishes by rename
 * (a fresh inode) and nothing rewrites a published file in place, so equal
 * identity means the bytes read are still the bytes at that path. */
interface FileIdentity {
	dev: bigint;
	ino: bigint;
	mtimeNs: bigint;
}

function statIdentity(file: string, io: ResultStoreIo): FileIdentity | null {
	try {
		const st = io.statSync(file, { bigint: true }) as unknown as { dev: bigint; ino: bigint; mtimeNs: bigint };
		return { dev: st.dev, ino: st.ino, mtimeNs: st.mtimeNs };
	} catch {
		return null;
	}
}

const sameIdentity = (a: FileIdentity, b: FileIdentity): boolean => a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs;

/** Terminal states outrank the spawn-time "running" marker. Used ONLY to
 * break an exact mtime tie (two publishes in the same millisecond) — never
 * to order distinct publishes. */
const statusRank = (status: unknown): number => (status === "running" ? 0 : 1);

/**
 * Move legacy flat result files that carry `parentSession` into their
 * per-session directory, and keep an already-migrated snapshot honest
 * while its legacy writer is still alive (an old process keeps publishing
 * to the flat path across an upgrade). The protocol has three invariants:
 *
 * - ADOPTION IS ORDERED BY PUBLISH TIME. Every copy keeps the original
 *   file's mtime (utimes after the rename), and a snapshot is written to
 *   the target only when it is newer than what the target already holds
 *   (an exact mtime tie is broken by state: terminal beats the spawn-time
 *   "running" marker). A migrator paused between its read and its write
 *   can therefore never downgrade a newer record another pass adopted.
 * - A PUBLISH IS NEVER DESTROYED BY A REMOVAL. The source is claimed by an
 *   atomic RENAME to `<name>.migrating`: whichever of the two renames (the
 *   writer's publish or this claim) lands first, the other side's state
 *   stays visible at one of the two names. Whatever bytes end up at the
 *   claim name are re-read and adopted before the claim is removed, so a
 *   newer publish that slid into the rename is carried over, not lost.
 * - NO NESTED CLAIMS. Only the regular pass renames a source into the
 *   fixed `.migrating` name (replacing a leftover claim of the same file
 *   is safe: that leftover was always adopted before it was created). The
 *   recovery sweep below adopts and removes leftovers WITHOUT renaming,
 *   so `.migrating.migrating` names cannot come into existence.
 *
 * The recovery sweep at the end adopts `*.json.migrating` leftovers from
 * interrupted passes with the same read/adopt/remove discipline. Safe
 * across concurrent processes: adoptions converge by publish time, claims
 * serialize on the single trash name, and a claim whose owner died is
 * recovered by the next pass. Unreadable or unparseable files, and files
 * without a string `parentSession` or whose name is not their own
 * sanitized id, stay in place. Never throws. Returns the number of source
 * files this call removed.
 */
export function migrateLegacyResults(dir: string, io: ResultStoreIo = fs): number {
	let moved = 0;
	try {
		for (const name of io.readdirSync(dir) as string[]) {
			if (!name.endsWith(".json")) continue;
			moved += migrateOne(dir, name, path.join(dir, name), io, false);
		}
	} catch {
		// unreadable directory: nothing to do
	}
	try {
		for (const name of io.readdirSync(dir) as string[]) {
			if (!name.endsWith(".json.migrating")) continue;
			moved += migrateOne(dir, name.slice(0, -".migrating".length), path.join(dir, name), io, true);
		}
	} catch {
		// unreadable directory: nothing to do
	}
	return moved;
}

/** Read `src` against a stable identity: the legacy writer publishes by
 * rename (a fresh inode), so if the identity changes between the pre-read
 * and post-read stat the writer published mid-read and the read repeats —
 * what is returned is exactly the state the post-read stat points at.
 * Gives up after a bounded number of retries (a writer hot-looping on the
 * file is left entirely to the next pass). */
function stableRead(src: string, io: ResultStoreIo): { parsed: Partial<AgentResult> | null; identity: FileIdentity } | null {
	for (let attempt = 0; attempt < 4; attempt++) {
		const before = statIdentity(src, io);
		if (!before) return null; // vanished (another process moved it)
		let parsed: Partial<AgentResult> | null = null;
		try {
			parsed = JSON.parse(io.readFileSync(src, "utf8")) as Partial<AgentResult> | null;
		} catch {
			return null; // corrupt/unreadable: leave to the next pass
		}
		const after = statIdentity(src, io);
		if (after && sameIdentity(before, after)) return { parsed, identity: after };
	}
	return null;
}

const migratable = (parsed: Partial<AgentResult> | null, name: string): parsed is Partial<AgentResult> =>
	!!parsed &&
	typeof parsed === "object" &&
	typeof parsed.id === "string" &&
	typeof parsed.parentSession === "string" &&
	!!parsed.parentSession &&
	`${sanitizeId(parsed.id)}.json` === name;

/** The ordering key of a record travels WITH its bytes: terminal states
 * outrank the spawn-time "running" marker, and within the same rank the
 * writer's own timestamps order the publishes (`endedAt` for terminal
 * records, `startedAt` for markers). No filesystem metadata takes part in
 * the ordering, so no crash window, utimes failure, sub-millisecond tie or
 * clock jump can poison it: a partial adoption can only ever leave the
 * record's OWN key on disk. */
interface ContentOrder {
	rank: number;
	at: number;
}

function contentOrder(parsed: Partial<AgentResult>): ContentOrder {
	const at = typeof parsed.endedAt === "number" ? parsed.endedAt : typeof parsed.startedAt === "number" ? parsed.startedAt : Number.NaN;
	return { rank: statusRank(parsed.status), at };
}

/** Write the snapshot to its per-session target only when it outranks what
 * the target already holds. An exact key tie with DIFFERENT bytes still
 * adopts: the writer legitimately re-publishes a terminal record with more
 * information (e.g. a late `processKilledAt`) while keeping `endedAt`. */
function adoptSnapshot(dir: string, name: string, parsed: Partial<AgentResult>, io: ResultStoreIo): boolean {
	const target = sessionDir(dir, parsed.parentSession as string);
	io.mkdirSync(target, { recursive: true });
	const dest = path.join(target, name);
	const tmp = `${dest}.tmp`;
	io.writeFileSync(tmp, JSON.stringify(parsed, null, "\t"), "utf8");
	// Re-check right before the rename: the target may have moved on since
	// this adoption began (a broken lock can produce a second writer), and a
	// stale snapshot must never land over a record that outranks it.
	const settled = readResultFile(dest, io);
	if (settled && !outranksOrEnriches(parsed, settled)) {
		try {
			io.unlinkSync(tmp);
		} catch {
			// tmp is invisible to readers; a leftover is swept by nothing but is harmless
		}
		return false; // never downgrade an adopted record
	}
	io.renameSync(tmp, dest);
	return true;
}

/** Does `incoming` outrank `current`, or enrich it under the same key? */
function outranksOrEnriches(parsed: Partial<AgentResult>, existing: Partial<AgentResult>): boolean {
	const incoming = contentOrder(parsed);
	const current = contentOrder(existing);
	const outranks =
		incoming.rank > current.rank ||
		(incoming.rank === current.rank && (Number.isNaN(current.at) ? !Number.isNaN(incoming.at) : !Number.isNaN(incoming.at) && incoming.at > current.at));
	const richer = incoming.rank === current.rank && incoming.at === current.at && JSON.stringify(parsed) !== JSON.stringify(existing);
	return outranks || richer;
}

function lockOwner(lock: string, io: ResultStoreIo): number {
	try {
		return Number.parseInt(String(io.readFileSync(lock, "utf8")).trim(), 10);
	} catch {
		return Number.NaN;
	}
}

function ownerAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException)?.code !== "ESRCH"; // EPERM etc: exists — treat as alive
	}
}

/** Break a lock whose owner is provably dead, without ever deleting a lock
 * another process may have (re)created. The stale lock is claimed by an
 * atomic RENAME first and re-inspected: if a new, live owner's lock
 * appears in between, it is renamed back into place untouched. */
function breakStaleLock(dir: string, lock: string, io: ResultStoreIo): boolean {
	const dead = lockOwner(lock, io);
	if (Number.isInteger(dead)) {
		if (ownerAlive(dead)) return false; // live owners are NEVER broken, however long they sit: a stuck-but-alive owner only leaves one flat file readable, while breaking one can lose a terminal record. Known cost: a lock whose dead owner's pid was recycled stays until that pid exits — degradation is one unmigrated (still readable) flat file.
	} else {
		// Unparsable: either an owner paused between creating the lock and
		// writing its pid, or an owner that crashed in that window. Break it
		// only after a grace period, so the paused-but-alive owner keeps its
		// exclusion while the crashed one is still reclaimed quickly.
		const st = statIdentity(lock, io);
		if (!st || Date.now() - Number(st.mtimeNs) / 1e6 < 60_000) return false;
	}
	const claimed = `${lock}.break-${process.pid}`;
	try {
		io.renameSync(lock, claimed);
	} catch {
		return false; // ENOENT: someone else broke it first (or it was released)
	}
	// Re-inspect the CLAIMED bytes: the path could have been recreated by a new owner between the read and the rename.
	const claimedOwner = lockOwner(claimed, io);
	if (claimedOwner === dead || (Number.isNaN(claimedOwner) && Number.isNaN(dead))) {
		try {
			io.unlinkSync(claimed);
		} catch {
			// raced: ignore
		}
		return true; // broken — retry acquisition
	}
	// A new owner's lock slid in: put it back untouched.
	try {
		io.renameSync(claimed, lock);
	} catch {
		// ENOENT on the destination: the new owner already finished and released — nothing to restore
	}
	return false;
}

/** Run `body` as the ONLY migrator of this result name. One writer per
 * name kills the check-then-write race on the target: a paused migrator
 * can no longer overwrite a newer record a concurrent pass adopted,
 * because no concurrent pass touches the name while the lock is held. The
 * lock is released only after re-proving ownership (by content), so a
 * stale-breaker can never make this finally delete a successor's lock. */
function withAdoptionLock(dir: string, name: string, io: ResultStoreIo, body: () => number): number {
	const lock = path.join(dir, `${name}.adopt-lock`);
	for (let attempt = 0; attempt < 4; attempt++) {
		let fd: number | undefined;
		try {
			fd = io.openSync(lock, "wx");
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") return 0; // unexpected: skip this pass
			if (ownerAlive(lockOwner(lock, io))) return 0; // a live migration owns this name: it finishes the job
			if (!breakStaleLock(dir, lock, io)) return 0; // could not safely break: another pass owns it now
			continue;
		}
		let owned = true;
		try {
			try {
				io.writeSync(fd, String(process.pid));
			} catch {
				// lock content is best-effort; an unparsable lock of a dead process is still breakable
			}
			return body();
		} finally {
			try {
				io.closeSync(fd);
			} catch {
				// already closed
			}
			if (owned && lockOwner(lock, io) === process.pid) {
				try {
					io.unlinkSync(lock);
				} catch {
					// already released by a breaker that saw this process dead
				}
			}
		}
	}
	return 0;
}

/** Migrate one file whose result name is `name`, currently parked at `src`
 * (the flat `<dir>/<name>`, or its `.migrating` leftover for the recovery
 * sweep). Returns 1 when the source was removed. Never throws. */
function migrateOne(dir: string, name: string, src: string, io: ResultStoreIo, recovery: boolean): number {
	return withAdoptionLock(dir, name, io, () => {
		try {
		const snap = stableRead(src, io);
		if (!snap || !migratable(snap.parsed, name)) return 0;
		adoptSnapshot(dir, name, snap.parsed, io);
		if (recovery) {
			// A leftover claim: only its owner ever renames into that name and
			// the owner adopted the content before creating it, so removing it
			// by identity can never destroy an unadopted state.
			const current = statIdentity(src, io);
			if (current && sameIdentity(current, snap.identity)) {
				try {
					io.unlinkSync(src);
					return 1;
				} catch {
					return 0;
				}
			}
			return 0;
		}
		// Claim the source by an atomic rename: the writer's own publish and
		// this rename serialize, so whichever lands first, the other side's
		// bytes survive at one of the two names.
		const trash = `${src}.migrating`;
		try {
			io.renameSync(src, trash);
		} catch {
			return 0; // ENOENT (another process finished it) or claim race: done elsewhere
		}
		// Whatever ended up at the claim name is adopted before the claim is
		// removed: our own snapshot when nothing raced, or the writer's newer
		// publish when its rename slid in first. If the claim cannot be READ
		// (a transient I/O error), its bytes are NOT deleted — the recovery
		// sweep of a later pass retries the adoption instead of losing it.
		const claimed = stableRead(trash, io);
		if (!claimed) return 0;
		if (migratable(claimed.parsed, name)) adoptSnapshot(dir, name, claimed.parsed, io);
		if (sameIdentity(statIdentity(trash, io) ?? ({ dev: 0n, ino: 0n, mtimeNs: 0n } as FileIdentity), claimed.identity)) {
			try {
				io.unlinkSync(trash);
				return 1;
			} catch {
				return 0;
			}
		}
		return 0;
	} catch {
			// unexpected filesystem error: leave everything for the next pass
			return 0;
		}
	});
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
