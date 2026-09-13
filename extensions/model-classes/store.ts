/**
 * Persistent storage for saved model classes (`cheap`, `smart`).
 *
 * One JSON file in the pi agent dir (`PI_CODING_AGENT_DIR`, default
 * `~/.pi/agent`) at `model-classes.json`, so the standard agent-dir
 * redirection applies and the file stays machine-local (never part of
 * agent-kit, never committed).
 *
 * Only `cheap` and `smart` are persisted. `default` is by definition the
 * current session state and is never written here.
 *
 * Writes are atomic (tmp file + rename): a failed write leaves the previous
 * file untouched, and the caller — not this module — decides whether an
 * error may be reported as success.
 *
 * This module stays free of pi imports so pure unit tests (bun test) can
 * import it without the pi package being resolvable.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Persisted model classes. */
export type ModelClassName = "cheap" | "smart";

/** Any model class reference, including the dynamic `default`. */
export type ModelClassRef = "default" | ModelClassName;

/** Pi thinking levels (mirrors pi-ai `ModelThinkingLevel`). */
export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** A concrete model + thinking pair as stored and resolved. */
export interface ModelPair {
	/** Canonical pi model identifier: `<provider>/<modelId>`. */
	model: string;
	thinking: ThinkingLevel;
}

/** Everything that can be persisted. */
export type StoredClasses = Partial<Record<ModelClassName, ModelPair>>;

/** Default location: `<agent-dir>/model-classes.json`. */
export function modelClassesPath(agentDir?: string): string {
	const dir = agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	return path.join(dir, "model-classes.json");
}

/** True when `value` is one of the seven pi thinking levels. */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Validate one persisted entry. Returns `undefined` for anything that is not
 * exactly `{ model: non-empty string, thinking: valid level }` — corrupt or
 * hand-edited entries degrade to "not set" instead of poisoning resolution.
 */
export function parseStoredPair(value: unknown): ModelPair | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const v = value as Record<string, unknown>;
	if (typeof v.model !== "string" || v.model.trim() === "") return undefined;
	if (!isThinkingLevel(v.thinking)) return undefined;
	return { model: v.model, thinking: v.thinking };
}

/**
 * Load the stored classes. Missing file → empty. Entries that fail
 * validation are treated as not set. Corrupt JSON throws: the caller should
 * surface the error rather than silently losing the user's saved classes.
 */
export function loadModelClasses(file: string): StoredClasses {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw e;
	}
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		throw new Error(`model classes storage is corrupt (not valid JSON): ${file}`);
	}
	if (typeof data !== "object" || data === null) {
		throw new Error(`model classes storage is corrupt (expected a JSON object): ${file}`);
	}
	const obj = data as Record<string, unknown>;
	const out: StoredClasses = {};
	for (const name of ["cheap", "smart"] as const) {
		const pair = parseStoredPair(obj[name]);
		if (pair) out[name] = pair;
	}
	return out;
}

/**
 * Persist one class (read-modify-write, atomic tmp+rename). Overwrites an
 * existing entry without confirmation, but only owns the one key it writes:
 * a storage file that cannot be confidently read (unreadable or corrupt)
 * aborts the save with an error — `set` never silently replaces classes it
 * could not see. Only a missing file starts a fresh object. Throws on any
 * write failure — the previous file (and the previous value) stays valid.
 */
export function saveModelClass(file: string, name: ModelClassName, pair: ModelPair): void {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") raw = "";
		else throw e;
	}
	let data: Record<string, unknown>;
	if (raw.trim() === "") {
		data = {}; // missing or empty file: nothing to preserve
	} else {
		// Deliberately outside any try: a corrupt file must fail the save, not
		// be replaced from a fresh object (that would drop the other class).
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error(`model classes storage is corrupt (expected a JSON object): ${file}`);
		}
		data = parsed as Record<string, unknown>;
	}
	data[name] = pair;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(data, null, "\t")}\n`, "utf8");
	fs.renameSync(tmp, file);
}
