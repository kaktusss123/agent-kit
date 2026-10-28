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
	"readdirSync" | "readFileSync" | "statSync" | "mkdirSync" | "writeFileSync" | "renameSync" | "unlinkSync" | "utimesSync" | "openSync" | "closeSync" | "writeSync"
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
	/** Publish time in ms — the ordering key for concurrent adoptions. */
	mtimeMs: number;
}

function statIdentity(file: string, io: ResultStoreIo): FileIdentity | null {
	try {
		const st = io.statSync(file, { bigint: true }) as unknown as { dev: bigint; ino: bigint; mtimeNs: bigint; mtimeMs: bigint | number };
		return { dev: st.dev, ino: st.ino, mtimeNs: st.mtimeNs, mtimeMs: Number(st.mtimeMs) };
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

/** Write the snapshot to its per-session target when it is newer than what
 * the target already holds; keep the original publish time on the copy so
 * the target's mtime stays the ordering key for every later pass. */
function adoptSnapshot(dir: string, name: string, parsed: Partial<AgentResult>, published: FileIdentity, io: ResultStoreIo): void {
	const target = sessionDir(dir, parsed.parentSession as string);
	io.mkdirSync(target, { recursive: true });
	const dest = path.join(target, name);
	const destStat = statIdentity(dest, io);
	if (destStat) {
		let destStatus: unknown;
		try {
			destStatus = (JSON.parse(io.readFileSync(dest, "utf8")) as { status?: unknown }).status;
		} catch {
			destStatus = undefined;
		}
		const newer = published.mtimeMs > destStat.mtimeMs;
		const tieUpgrade = published.mtimeMs === destStat.mtimeMs && statusRank(parsed.status) > statusRank(destStatus);
		if (!newer && !tieUpgrade) return; // never downgrade an adopted record
	}
	const tmp = `${dest}.tmp`;
	io.writeFileSync(tmp, JSON.stringify(parsed, null, "\t"), "utf8");
	io.renameSync(tmp, dest);
	try {
		io.utimesSync(dest, new Date(published.mtimeMs), new Date(published.mtimeMs));
	} catch {
		// ordering key best-effort: without it a later pass may re-adopt the same record once
	}
}

/** Is the adoption lock held by a LIVE process (or too fresh to break)?
 * The lock holds its owner's pid; a dead owner means a crashed migration
 * whose lock is broken on the spot. An unparsable lock is broken only
 * after a grace period, and even a live owner cannot hold a name forever:
 * no migration runs for minutes, so an old-enough lock is broken too. */
function adoptionLockHeld(lock: string, io: ResultStoreIo): boolean {
	let owner = Number.NaN;
	try {
		owner = Number.parseInt(String(io.readFileSync(lock, "utf8")).trim(), 10);
	} catch {
		// absent or unreadable: not held
		return false;
	}
	const age = () => {
		const st = statIdentity(lock, io);
		return st ? Date.now() - st.mtimeMs : Number.POSITIVE_INFINITY;
	};
	if (Number.isInteger(owner) && owner !== process.pid) {
		try {
			process.kill(owner, 0);
			return age() < 600_000; // alive, and no migration holds a name for ten minutes
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code === "ESRCH") return false; // owner is gone: break it
			return age() < 600_000; // not ours to signal: trust it while fresh
		}
	}
	return age() < 120_000; // unparsable/self-leftover: give it a grace period only
}

/** Run `body` as the ONLY migrator of this result name. One writer per
 * name kills the check-then-write race on the target: a paused migrator
 * can no longer overwrite a newer record a concurrent pass adopted,
 * because no concurrent pass touches the name while the lock is held. */
function withAdoptionLock(dir: string, name: string, io: ResultStoreIo, body: () => number): number {
	const lock = path.join(dir, `${name}.adopt-lock`);
	for (let attempt = 0; attempt < 3; attempt++) {
		let fd: number | undefined;
		try {
			fd = io.openSync(lock, "wx");
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") return 0; // unexpected: skip this pass
			if (adoptionLockHeld(lock, io)) return 0; // a live migration owns this name: it finishes the job
			try {
				io.unlinkSync(lock); // stale (crashed owner): break and retry
			} catch {
				// raced: another process broke it first
			}
			continue;
		}
		try {
			try {
				io.writeSync(fd, String(process.pid));
			} catch {
				// lock content is best-effort; the pid check degrades to the age grace
			}
			return body();
		} finally {
			try {
				io.closeSync(fd);
			} catch {
				// already closed
			}
			try {
				io.unlinkSync(lock);
			} catch {
				// already released by a stale-breaker after the grace period
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
		adoptSnapshot(dir, name, snap.parsed, snap.identity, io);
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
		// publish when its rename slid in first.
		const claimed = stableRead(trash, io);
		if (claimed && migratable(claimed.parsed, name)) adoptSnapshot(dir, name, claimed.parsed, claimed.identity, io);
		try {
			io.unlinkSync(trash);
			return 1;
		} catch {
			return 0;
		}
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
