/**
 * Diagnostic identity of this inspection adapter, read from real files.
 *
 * The inspection protocol carries two identity strings per provider:
 * `adapterVersion` (non-empty diagnostic string) and `buildRevision`
 * (revision or null). Both are diagnostics only — a consumer decides what a
 * provider can do from the exact capability versions, never from a version
 * comparison. They must still be truthful, so nothing here is a
 * hand-maintained constant: the values come from files that describe THIS
 * checkout, resolved from the extension directory upwards.
 *
 * Per candidate directory, in order:
 *   1. `package.json` with a string `version` — a declared release version;
 *   2. `.git` (a directory, or a worktree/submodule pointer file) — its HEAD
 *      revision, read straight from the Git files. A subprocess would put
 *      `PATH` and repository hooks on the startup path of every Pi session,
 *      so `git rev-parse` is deliberately not used;
 *   3. `manifest.json` with a string `sha` — an `agent-kit snapshot` release
 *      writes that manifest next to `extensions/`, which is how a pinned
 *      headless install keeps a real revision without a `.git` directory.
 *
 * The first hit wins. Nothing found (for example a copied tree) yields
 * `agent-kit@unknown` and a null revision rather than a guess.
 *
 * A normal Pi install loads the extension through symlinks
 * (`<agent-dir>/extensions/<name>` pointing into a checkout or a pinned
 * release), so the walk starts from the real path of the module directory: the
 * identity describes the code that is actually loaded, not the link that
 * names it. The link path is still walked as a fallback, so a manifest written
 * next to the links keeps working too.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Enough levels for `<repo>`, `<release>/<sha>`, and `<release>/<sha>/extensions` layouts. */
const MAX_WALK_UP = 4;
/** Abbreviated length used inside the human-facing adapter version. */
const SHORT_REVISION_LENGTH = 12;
const MAX_IDENTITY_BYTES = 4096;
const REVISION_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** A ref name we are willing to resolve; no parent traversal, no absolute paths. */
const REF_NAME_PATTERN = /^refs\/[A-Za-z0-9._\/-]+$/;

export interface ProviderIdentity {
	/** `agent-kit@<version|short-revision|unknown>`; diagnostics only. */
	adapterVersion: string;
	/** Full revision this code was built from, or null when unknown. */
	buildRevision: string | null;
}

/** Resolve the identity of the code that lives in `moduleDir` (an extension directory). */
export function resolveProviderIdentity(moduleDir: string): ProviderIdentity {
	for (const root of identityRoots(moduleDir)) {
		const identity = walkUpForIdentity(root);
		if (identity) return identity;
	}
	return { adapterVersion: "agent-kit@unknown", buildRevision: null };
}

/**
 * Candidate starting points, most truthful first: the real path of the loaded
 * module (symlinked installs) and then the path as it was given (a manifest
 * may live beside the links). Duplicates collapse, so a plain directory is a
 * single walk.
 */
function identityRoots(moduleDir: string): string[] {
	const resolved = path.resolve(moduleDir);
	const real = realpathOrUndefined(resolved);
	return real && real !== resolved ? [real, resolved] : [resolved];
}

function walkUpForIdentity(root: string): ProviderIdentity | undefined {
	let dir = root;
	for (let depth = 0; depth <= MAX_WALK_UP; depth += 1) {
		const version = readPackageVersion(dir);
		const revision = readGitRevision(dir) ?? readSnapshotRevision(dir);
		if (version !== undefined) {
			return { adapterVersion: `agent-kit@${version}`, buildRevision: revision };
		}
		if (revision !== null) {
			return { adapterVersion: `agent-kit@${revision.slice(0, SHORT_REVISION_LENGTH)}`, buildRevision: revision };
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

function readPackageVersion(dir: string): string | undefined {
	const manifest = readJson(path.join(dir, "package.json"));
	const version = manifest?.version;
	return typeof version === "string" && version.length > 0 && version.length <= 256 ? version : undefined;
}

function readSnapshotRevision(dir: string): string | null {
	const manifest = readJson(path.join(dir, "manifest.json"));
	const sha = manifest?.sha;
	return typeof sha === "string" && REVISION_PATTERN.test(sha) ? sha : null;
}

function readGitRevision(dir: string): string | null {
	const gitPath = path.join(dir, ".git");
	const stat = statOrUndefined(gitPath);
	if (!stat) return null;
	let gitDir: string | null = null;
	if (stat.isDirectory()) gitDir = gitPath;
	else if (stat.isFile()) {
		// Worktree/submodule checkouts keep the repository state elsewhere.
		const pointer = readText(gitPath);
		const match = pointer ? /^gitdir:\s*(.+)$/.exec(pointer) : null;
		if (match) gitDir = path.resolve(dir, match[1].trim());
	}
	return gitDir ? readHeadRevision(gitDir) : null;
}

function readHeadRevision(gitDir: string): string | null {
	const head = readText(path.join(gitDir, "HEAD"));
	if (!head) return null;
	if (!head.startsWith("ref:")) return REVISION_PATTERN.test(head) ? head : null;
	const ref = head.slice("ref:".length).trim();
	if (!REF_NAME_PATTERN.test(ref) || ref.includes("..")) return null;
	// `commondir` is how a linked worktree points at the shared ref store.
	const commonDirText = readText(path.join(gitDir, "commondir"));
	const commonDir = commonDirText ? path.resolve(gitDir, commonDirText) : gitDir;
	for (const base of [commonDir, gitDir]) {
		const direct = readText(path.join(base, ref));
		if (direct && REVISION_PATTERN.test(direct)) return direct;
	}
	return readPackedRef(commonDir, ref);
}

function readPackedRef(commonDir: string, ref: string): string | null {
	const packed = readText(path.join(commonDir, "packed-refs"));
	if (!packed) return null;
	for (const line of packed.split("\n")) {
		if (line.startsWith("#") || line.startsWith("^")) continue;
		const [sha, name] = line.trim().split(/\s+/, 2);
		if (name === ref && REVISION_PATTERN.test(sha)) return sha;
	}
	return null;
}

function realpathOrUndefined(target: string): string | undefined {
	try {
		return fs.realpathSync(target);
	} catch {
		return undefined;
	}
}

function statOrUndefined(target: string): fs.Stats | undefined {
	try {
		return fs.statSync(target);
	} catch {
		return undefined;
	}
}

/** Bounded text read: these files are small, and a huge one is not a revision. */
function readText(target: string): string | null {
	try {
		const stat = fs.statSync(target);
		if (!stat.isFile() || stat.size > MAX_IDENTITY_BYTES) return null;
		return fs.readFileSync(target, "utf8").trim();
	} catch {
		return null;
	}
}

function readJson(target: string): Record<string, unknown> | undefined {
	const text = readText(target);
	if (text === null) return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}
