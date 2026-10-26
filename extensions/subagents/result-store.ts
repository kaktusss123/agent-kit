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
 * `<resultsDir>/<sanitizedId>.json`. Readers check the per-session directory
 * first and fall back to the flat one; {@link migrateLegacyResults} relocates
 * flat files that carry `parentSession`.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentResult } from "./types";
import { validateLastAssistantText } from "./last-text";

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
export function loadResult(agentId: string, dir: string): AgentResult | null {
	const name = `${sanitizeId(agentId)}.json`;
	// The parent session is unknown to the caller: look in every per-session
	// directory, then in the legacy flat one.
	for (const base of [...sessionDirs(dir), dir]) {
		const found = readResultFile(path.join(base, name));
		if (found) return found;
	}
	return null;
}

function sessionDirs(dir: string): string[] {
	try {
		return fs
			.readdirSync(path.join(dir, "by-session"), { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => path.join(dir, "by-session", e.name));
	} catch {
		return [];
	}
}

function readResultFile(file: string): AgentResult | null {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
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
export function sumSessionCost(dir: string, parentSession: string): number {
	let total = 0;
	for (const result of listResults(dir, [sessionDir(dir, parentSession), dir])) {
		if (result.parentSession === parentSession) total += result.tokens?.cost ?? 0;
	}
	return total;
}

/**
 * Parse `.json` files from the given directories in order (per-session
 * directories first, flat last). A file name already seen in an earlier
 * directory is skipped, so a migrated result is never counted twice.
 * Unreadable, partial or non-object files are skipped; `.tmp` files from
 * `saveResult` are excluded by the extension filter.
 */
function listResults(dir: string, bases: string[]): AgentResult[] {
	const seen = new Set<string>();
	const out: AgentResult[] = [];
	for (const base of bases) {
		let entries: string[];
		try {
			entries = fs.readdirSync(base);
		} catch {
			continue;
		}
		for (const name of entries) {
			if (!name.endsWith(".json") || seen.has(name)) continue;
			try {
				const parsed = JSON.parse(fs.readFileSync(path.join(base, name), "utf8")) as AgentResult;
				if (!parsed || typeof parsed !== "object") continue;
				seen.add(name);
				out.push(parsed);
			} catch {
				// corrupt/partial file: skip, never break the rollup
			}
		}
	}
	return out;
}

/** Every parsed result in the store: all per-session directories, then the legacy flat one. */
export function listAllResults(dir: string): AgentResult[] {
	return listResults(dir, [...sessionDirs(dir), dir]);
}

/**
 * Move legacy flat result files that carry `parentSession` into their
 * per-session directory. Idempotent and safe across concurrent processes:
 * the target is created with a hard link (fails with EEXIST instead of
 * overwriting), then the source is unlinked, so the content is never absent
 * from both places and no process can clobber another's copy. A missing
 * source (another process moved it) or an existing target is skipped;
 * unreadable or unparseable files, and files without a string `parentSession`
 * or whose name is not their own sanitized id, stay in place. Never throws.
 * Returns the number of files this call moved.
 */
export function migrateLegacyResults(dir: string): number {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return 0;
	}
	let moved = 0;
	for (const name of entries) {
		if (!name.endsWith(".json")) continue;
		try {
			const src = path.join(dir, name);
			const parsed = JSON.parse(fs.readFileSync(src, "utf8")) as Partial<AgentResult> | null;
			if (!parsed || typeof parsed !== "object") continue;
			if (typeof parsed.id !== "string" || typeof parsed.parentSession !== "string" || !parsed.parentSession) continue;
			if (`${sanitizeId(parsed.id)}.json` !== name) continue;
			const target = sessionDir(dir, parsed.parentSession);
			fs.mkdirSync(target, { recursive: true });
			try {
				fs.linkSync(src, path.join(target, name));
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "EEXIST") continue; // target already present: leave source
				throw err;
			}
			try {
				fs.unlinkSync(src);
				moved++;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			}
		} catch {
			// ENOENT (moved by another process), unreadable or unparseable: leave as is
		}
	}
	return moved;
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
