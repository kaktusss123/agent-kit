/**
 * Fixed subagent roles and their per-machine model bindings.
 *
 * agent-kit defines a closed role set; users cannot invent roles, they only
 * bind a role to a model in `<pi agent dir>/subagent-roles.json`:
 *
 *   { "<role>": "provider/id[:thinking]" }
 *
 * The file is machine-local (never part of agent-kit). Reads are fresh on
 * every use. A missing or empty file means "nothing bound". Corrupt JSON,
 * an unknown key, or a non-string value is an error, never silently
 * ignored: a possibly-bound role must not downgrade to the session model.
 * Writes are atomic (tmp file + rename).
 *
 * Pure module: no pi imports.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveAgentDir } from "./agent-dir.ts";

/** The closed role set, in display order. */
export const ROLES = ["explore", "helper", "review", "owner"] as const;

export type Role = (typeof ROLES)[number];

/** One-line meaning of each role, used by guidance and the command table. */
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
	explore: "cheap read-only research",
	helper: "generic plain subagent (default for plain spawns)",
	review: "independent fresh-context reviewer",
	owner: "RepoOwner (workspace spawns)",
};

export function isRole(value: unknown): value is Role {
	return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Per-role bound model specs (`provider/id[:thinking]`). Partial by design. */
export type RoleBindings = Partial<Record<Role, string>>;

/** Default location: `<agent-dir>/subagent-roles.json` (honors PI_CODING_AGENT_DIR). */
export function rolesPath(agentDir?: string): string {
	const dir = agentDir ?? resolveAgentDir();
	return path.join(dir, "subagent-roles.json");
}

function corrupt(file: string, why: string): Error {
	return new Error(
		`subagent role bindings are invalid (${why}): ${file}. ` +
			`Fix: edit the file by hand to a valid table, or delete it and rebind with \`/subagent-role <role> <provider/id[:thinking]>\`; \`/subagent-role <role> unset\` cannot repair it.`,
	);
}

function readObject(file: string): Record<string, unknown> {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(
			`subagent role bindings are unreadable: ${file} (${e instanceof Error ? e.message : String(e)}). Fix: repair permissions or delete the file, then rebind with \`/subagent-role <role> <provider/id[:thinking]>\`.`,
		);
	}
	if (raw.trim() === "") return {};
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		throw corrupt(file, "not valid JSON");
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) throw corrupt(file, "expected a JSON object");
	return data as Record<string, unknown>;
}

/** Load the bindings; throws (naming the file) on anything but a clean table. */
export function loadRoleBindings(file: string): RoleBindings {
	const obj = readObject(file);
	const bindings: RoleBindings = {};
	for (const [key, value] of Object.entries(obj)) {
		if (!isRole(key)) throw corrupt(file, `unknown role "${key}"; roles: ${ROLES.join(", ")}`);
		if (typeof value !== "string" || value.trim() === "") {
			throw corrupt(file, `role "${key}" must map to a non-empty "provider/id[:thinking]" string`);
		}
		bindings[key] = value.trim();
	}
	return bindings;
}

function writeObject(file: string, data: Record<string, unknown>): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(data, null, "\t")}\n`, "utf8");
	fs.renameSync(tmp, file);
}

/** Bind one role (read-modify-write, atomic). Corrupt storage aborts the write. */
export function saveRoleBinding(file: string, role: Role, spec: string): void {
	const data: Record<string, unknown> = { ...loadRoleBindings(file) };
	data[role] = spec;
	writeObject(file, data);
}

/** Remove one binding (atomic); returns whether one existed. */
export function unsetRoleBinding(file: string, role: Role): boolean {
	const data: Record<string, unknown> = { ...loadRoleBindings(file) };
	if (!Object.hasOwn(data, role)) return false;
	delete data[role];
	writeObject(file, data);
	return true;
}
