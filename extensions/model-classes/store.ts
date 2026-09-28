/**
 * Persistent storage for saved model classes and spawn-mode routing.
 *
 * One JSON file in the pi agent dir (`PI_CODING_AGENT_DIR`, default
 * `~/.pi/agent`) at `model-classes.json`, so the standard agent-dir
 * redirection applies and the file stays machine-local (never part of
 * agent-kit, never committed).
 *
 * Any number of user-named classes are persisted (`cheap`/`smart` are just
 * ordinary names now). `default` is by definition the current session state
 * and is never written here. The reserved top-level key `routing` holds the
 * spawn-mode routing table; every other key is a class name and must match
 * the class-name grammar — garbage keys degrade to "not set" exactly like
 * invalid pairs.
 *
 * Class order is the storage insertion order (JSON key order); it defines
 * `/model-class next` cycling.
 *
 * Writes are atomic (tmp file + rename): a failed write leaves the previous
 * file untouched, and the caller — not this module — decides whether an
 * error may be reported as success. A file that cannot be confidently read
 * (unreadable or corrupt JSON) aborts every write: `set`/`route`/`unset`
 * never silently replace state they could not see.
 *
 * This module stays free of pi imports so pure unit tests (bun test) can
 * import it without the pi package being resolvable.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Spawn modes the routing table can default (the subagent tool surface). */
export type SpawnMode = "plain" | "repoOwner";

/** All spawn modes in stable display/storage order. */
export const SPAWN_MODES = ["plain", "repoOwner"] as const;

/** A user-named model class. Grammar-validated by `isClassName`. */
export type ModelClassName = string;

/** Any model class reference, including the dynamic `default`. */
export type ModelClassRef = "default" | ModelClassName;

/** Routing target: a saved class name, or `inherit` (reset to session pair). */
export type RouteTarget = ModelClassName | "inherit";

/** Class-name grammar (SPEC R1). */
export const CLASS_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Reserved words that are not valid class names (SPEC R1): `default` is the
 * live session, `inherit` is the routing reset, the rest are subcommands or
 * the reserved storage key.
 */
export const RESERVED_CLASS_WORDS = [
	"default",
	"inherit",
	"route",
	"next",
	"set",
	"unset",
	"routing",
] as const;

/** True when `name` is a valid class name (grammar + not reserved). */
export function isClassName(name: string): name is ModelClassName {
	return CLASS_NAME_PATTERN.test(name) && !(RESERVED_CLASS_WORDS as readonly string[]).includes(name);
}

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

/** Persisted model classes, keyed by name in storage (insertion) order. */
export type StoredClasses = Record<ModelClassName, ModelPair>;

/** Routing table: spawn mode -> routed class reference. Partial by design. */
export type RoutingTable = Partial<Record<SpawnMode, ModelClassName>>;

/** Everything the storage file carries. */
export interface StoredModelClasses {
	classes: StoredClasses;
	routing: RoutingTable;
}

/** Reserved top-level key holding the routing table. */
export const ROUTING_KEY = "routing";

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
 * Read and JSON-parse the storage file. Returns `undefined` for a missing
 * or EMPTY/whitespace-only file — mirroring the write path
 * (`readModifiableStorage`), both legitimately mean "no state" and must not
 * fail closed; only genuinely corrupt content throws so callers never
 * silently lose saved state.
 */
function readStorageObject(file: string): Record<string, unknown> | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw e;
	}
	if (raw.trim() === "") return undefined; // empty file ≡ missing file: no state
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		throw new Error(`model classes storage is corrupt (not valid JSON): ${file}`);
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new Error(`model classes storage is corrupt (expected a JSON object): ${file}`);
	}
	return data as Record<string, unknown>;
}

/**
 * Parse the routing table out of the reserved `routing` value. Degrade
 * semantics: a non-object `routing` and unknown modes are dropped — the
 * mode falls back to session inheritance. A STRING target for a known mode
 * is preserved structurally even when it is not a valid/saved class name
 * (reserved words like `default`, garbage like `"INVALID!"`): a present
 * routing value is unknown-but-set state, not absent state, so it must
 * fail closed at spawn resolution with the routing-aware error (SPEC D4)
 * and stay visibly flagged in status — never silently degrade to
 * inheritance. Write-time validation (`/model-class route`) is unchanged.
 * Non-string values (numbers, null, objects) cannot be a class reference
 * and are dropped.
 */
function parseRouting(value: unknown): RoutingTable {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const raw = value as Record<string, unknown>;
	const routing: RoutingTable = {};
	for (const mode of SPAWN_MODES) {
		const target = raw[mode];
		if (typeof target === "string") routing[mode] = target;
	}
	return routing;
}

/**
 * Load the whole storage file: every valid class (in insertion order) plus
 * the routing table. Missing or empty file → empty. Entries that fail
 * validation are treated as not set. Corrupt JSON throws: the caller should
 * surface the error rather than silently losing the user's saved classes.
 */
export function loadStoredFile(file: string): StoredModelClasses {
	const obj = readStorageObject(file);
	const classes: StoredClasses = {};
	if (!obj) return { classes, routing: {} };
	for (const [name, value] of Object.entries(obj)) {
		if (name === ROUTING_KEY) continue;
		if (!isClassName(name)) continue; // garbage/reserved keys degrade to not set
		const pair = parseStoredPair(value);
		if (pair) classes[name] = pair;
	}
	return { classes, routing: parseRouting(obj[ROUTING_KEY]) };
}

/** Load only the saved classes (insertion order). */
export function loadModelClasses(file: string): StoredClasses {
	return loadStoredFile(file).classes;
}

/**
 * Read the file as a modifiable whole-object state for a write. Missing or
 * empty file → fresh object; corrupt JSON throws so the write can never
 * silently replace classes it could not see.
 */
function readModifiableStorage(file: string): Record<string, unknown> {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") raw = "";
		else throw e;
	}
	if (raw.trim() === "") return {}; // missing or empty file: nothing to preserve
	// Deliberately fail on corrupt content (never replace it from a fresh
	// object — that would drop the other classes); the wrapped message keeps
	// the failure shape identical to loadStoredFile.
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`model classes storage is corrupt (not valid JSON): ${file}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`model classes storage is corrupt (expected a JSON object): ${file}`);
	}
	return parsed as Record<string, unknown>;
}

/** Atomic tmp+rename write of the whole storage object. */
function writeStorageObject(file: string, data: Record<string, unknown>): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(data, null, "\t")}\n`, "utf8");
	fs.renameSync(tmp, file);
}

/**
 * Persist one class (read-modify-write, atomic tmp+rename). Overwrites an
 * existing entry without confirmation, but only owns the one key it writes:
 * a storage file that cannot be confidently read (unreadable or corrupt)
 * aborts the save with an error — `set` never silently replaces classes it
 * could not see. Routing and unknown keys are preserved. Throws on any
 * write failure — the previous file (and the previous value) stays valid.
 */
export function saveModelClass(file: string, name: ModelClassName, pair: ModelPair): void {
	const data = readModifiableStorage(file);
	data[name] = pair;
	writeStorageObject(file, data);
}

/**
 * Set or reset one spawn mode's routed default. `inherit` removes the mode's
 * entry (session inheritance). Read-modify-write over the whole file,
 * atomic; corrupt storage aborts the write. The caller validates that a
 * class target is actually saved (the command layer); this module persists
 * what it is told.
 */
export function saveRouting(file: string, mode: SpawnMode, target: RouteTarget): void {
	const data = readModifiableStorage(file);
	const routing = parseRouting(data[ROUTING_KEY]);
	if (target === "inherit") delete routing[mode];
	else routing[mode] = target;
	data[ROUTING_KEY] = routing;
	writeStorageObject(file, data);
}

/** Outcome of `unset`: either deleted (or already absent), or refused. */
export type UnsetModelClassOutcome =
	| { ok: true; deleted: boolean }
	| { ok: false; error: string; referencedBy: SpawnMode[] };

/**
 * Delete a saved class (SPEC R1 `unset`). Refuses while any routing entry
 * references the class, naming the modes to reset first. Read-modify-write,
 * atomic; corrupt storage aborts. Deleting a name that is not saved (and not
 * routed) succeeds as a no-op.
 */
export function unsetModelClass(file: string, name: ModelClassName): UnsetModelClassOutcome {
	const data = readModifiableStorage(file);
	const routing = parseRouting(data[ROUTING_KEY]);
	const referencedBy = SPAWN_MODES.filter((mode) => routing[mode] === name);
	if (referencedBy.length > 0) {
		return {
			ok: false,
			referencedBy,
			error:
				`Model class "${name}" is referenced by routing for ${referencedBy.map((m) => `"${m}"`).join(" and ")}. ` +
				`Reset the route(s) first: \`/model-class route <mode> inherit\`.`,
		};
	}
	const deleted = Object.prototype.hasOwnProperty.call(data, name);
	delete data[name];
	if (deleted) writeStorageObject(file, data);
	return { ok: true, deleted };
}
