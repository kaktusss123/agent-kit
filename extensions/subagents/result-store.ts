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
 * `<resultsDir>/<sanitizedId>.json`. Nothing moves or deletes files: readers
 * look at BOTH the per-session directories and the flat one and merge by id
 * with {@link outranks} (terminal status beats "running"; between equals the
 * later `endedAt`, falling back to `startedAt`, wins), so a record that
 * exists in both places is returned once and never double-counted.
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
 * True when `a` should replace `b` for the same id: a terminal status beats
 * "running", and between equals the later `endedAt` (fallback `startedAt`)
 * wins. Ties keep the incumbent.
 */
function outranks(a: Partial<AgentResult>, b: Partial<AgentResult>): boolean {
	const terminal = (r: Partial<AgentResult>): number => (r.status === "running" ? 0 : 1);
	if (terminal(a) !== terminal(b)) return terminal(a) > terminal(b);
	const at = (r: Partial<AgentResult>): number => r.endedAt ?? r.startedAt ?? Number.NEGATIVE_INFINITY;
	return at(a) > at(b);
}

/** Per-session directories first, then the flat one (so ties favor the per-session copy). */
function allBases(dir: string): string[] {
	try {
		const sessions = fs
			.readdirSync(path.join(dir, "by-session"), { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => path.join(dir, "by-session", e.name));
		return [...sessions, dir];
	} catch {
		return [dir];
	}
}

/**
 * Load one persisted result. Terminal records written by earlier sessions
 * are the source for `subagent result` after a main restart, so the optional
 * bounded channel gets a read-time boundary here: a malformed
 * `lastAssistantText` is dropped, never forwarded into live projections;
 * every other persisted fact passes through untouched and the file itself
 * is never rewritten (old/legacy records stay as written). The parent
 * session is unknown to the caller, so every per-session directory and the
 * flat one are read and the copies merged by {@link outranks}.
 */
export function loadResult(agentId: string, dir: string): AgentResult | null {
	const name = `${sanitizeId(agentId)}.json`;
	let best: AgentResult | null = null;
	for (const base of allBases(dir)) {
		const found = readResultFile(path.join(base, name));
		if (found && (!best || outranks(found, best))) best = found;
	}
	return best;
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
 * nothing; an id present in both layouts is counted once.
 */
export function sumSessionCost(dir: string, parentSession: string): number {
	let total = 0;
	for (const result of listResults([sessionDir(dir, parentSession), dir])) {
		if (result.parentSession === parentSession) total += result.tokens?.cost ?? 0;
	}
	return total;
}

/**
 * Parse `.json` files from the given directories and merge them by file
 * name with {@link outranks}. Unreadable, partial or non-object files are
 * skipped; `.tmp` files from `saveResult` are excluded by the extension
 * filter.
 */
function listResults(bases: string[]): AgentResult[] {
	const byName = new Map<string, AgentResult>();
	for (const base of bases) {
		let entries: string[];
		try {
			entries = fs.readdirSync(base);
		} catch {
			continue;
		}
		for (const name of entries) {
			if (!name.endsWith(".json")) continue;
			try {
				const parsed = JSON.parse(fs.readFileSync(path.join(base, name), "utf8")) as AgentResult;
				if (!parsed || typeof parsed !== "object") continue;
				const current = byName.get(name);
				if (!current || outranks(parsed, current)) byName.set(name, parsed);
			} catch {
				// corrupt/partial file: skip, never break the rollup
			}
		}
	}
	return [...byName.values()];
}

/** Every parsed result in the store: all per-session directories and the flat one, merged by id. */
export function listAllResults(dir: string): AgentResult[] {
	return listResults(allBases(dir));
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
