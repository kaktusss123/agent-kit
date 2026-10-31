// `agent-kit snapshot`: content-addressed release snapshots of the committed tree.
//
// Headless sessions run pi with --no-extensions and explicit -e paths into
// <releases>/current/extensions, so they must not read the live checkout.
//
// Layout: <releases>/<full HEAD sha>/{extensions,node_modules,manifest.json};
// <releases>/current is a relative symlink to a complete snapshot and the only
// mutable path.
//
// Identity: a snapshot is named by the HEAD commit, so it is built from that
// commit only. A checkout with uncommitted or untracked changes is refused:
// there is no content identifier to publish it under, and reusing the sha would
// let two different file sets share one name. Dirty snapshots written by older
// versions are detected in the manifest and refused instead of being reused or
// relabelled. HEAD and the working-tree state are read under the releases lock
// and re-read immediately before the copy, so a command that waited for a busy
// lock cannot publish a tree it has not looked at again.
//
// Publication is atomic on a local filesystem:
//   * the snapshot is built in <releases>/.tmp-<sha>-<pid>-<rand> and renamed
//     to its final name, so a directory under a final name is complete by
//     construction;
//   * the rename is rename(2), which never nests the source inside a target
//     directory (unlike plain mv), but DOES replace an existing file or
//     symlink, so the final name is type-checked and checked again after the
//     rename;
//   * current is flipped by renaming a freshly created symlink over it in one
//     syscall, so current always names a complete snapshot.
// A failed run leaves the previous current untouched and removes its temporary
// tree on the way out. A terminated run (SIGKILL, and SIGTERM/SIGINT too, which
// Node cannot service while the synchronous copy holds the stack - the default
// disposition ends the process at once) leaves its temporary tree and the lock
// of a dead owner behind; the next run that owns the releases dir sweeps both.
//
// Removal: nothing is removed under the name it is reachable by. An entry is
// first renamed in one syscall to a reserved name (`.trash-<token>-<name>`), and
// only that trash name is walked and deleted afterwards. The publication steps
// never write a reserved name - a snapshot is published as a 40-hex commit sha
// and current is a symlink to that sha - so the unbounded part of a removal can
// never reach what current points at: the published name disappeared in the
// syscall that started the removal. What is already a reserved name is deleted
// where it is, without a second prefix: the name is unreachable for a
// publication anyway, and prefixing it again would grow a leftover that keeps
// failing to be removed by one token per attempt, up to ENAMETOOLONG. The rename
// is the only step that needs an ownership check, and the check is the last thing
// before it: the permission walk that makes a copied 0555 tree removable and the
// probe for a free trash name both read the filesystem, so both run before the
// check. Between the check and the rename the writer makes no filesystem call at
// all; the window that remains is the one syscall itself.
//
// Content: extensions/ is the committed file set of that directory (git
// ls-files --cached), copied for real (symlinks preserved, git modes applied to
// files, directory modes taken from the checkout). Walking the directory instead
// would publish ignored or untracked files that the commit does not contain, so
// composition - not just cleanliness - comes from git. node_modules/ is not part
// of the commit; it is hardlinked from the previous complete snapshot - a
// published snapshot is never rewritten in place, so sharing those inodes is
// safe - or really copied from the checkout on the first sync. A checkout's
// node_modules is never hardlinked: the checkout keeps changing, and a shared
// inode would change a published snapshot with it. Only a manifest written by
// this writer (schema 2) proves that its node_modules is independent of the
// checkout; a schema-1 artifact of the pre-Node writer hardlinked node_modules
// against the checkout, so it is never used as a hardlink source.
//
// Locking: every operation on one releases dir runs under one exclusive lock,
// <releases>/.lock, created as a symlink whose target is the owner record
// (pid, host, token, start time). Creating a symlink publishes the lock and its
// owner in one atomic syscall, so a lock never exists without an owner record.
// The lock is released by moving it aside and re-reading what landed there, so
// a lock this process does not own is never deleted; a recovered record goes
// back by symlink(2), which fails with EEXIST instead of replacing a lock that
// took the name in the meantime, and it carries a fresh token as well: the owner
// of a displaced instance lost the name for at least one syscall, exactly like
// the owner of a lock a takeover put back, so it must not pass its next
// ownership check either. A lock is taken over only when its recorded
// owner is provably gone: same host and a pid that no longer exists. Age is not
// evidence - a slow but live snapshot keeps its lock, and a lock that cannot be
// attributed is a bounded error naming its owner instead of a stolen lock. A
// recycled pid makes a dead owner look alive, which fails in the safe direction
// (bounded error, no takeover). The measurement that justifies a takeover can
// itself go stale, so the takeover re-reads the record .lock names at that
// moment and decides on the instance it actually moved aside: a lock whose owner
// is not provably gone is put back, and the record that goes back carries a
// fresh token instead of the one the displaced owner lost. The displaced owner
// therefore fails its next ownership check instead of commissioning a step
// against a releases dir another process has changed in the window it did not
// hold the lock. Waiters poll boundedly (60 s default,
// AGENT_KIT_SNAPSHOT_LOCK_TIMEOUT overrides it). There is no compare-and-swap
// for a symlink, so the remaining window between the re-read and the claim is a
// syscall wide; a live owner that ever loses its lock that way stops at its next
// ownership check instead of writing to a releases dir it does not own. Every
// step another process can observe - the publish rename, the current flip, the
// rename of a removed entry into a trash name - is commissioned as the last
// thing before it: the permission walk that makes a copied 0555 tree removable
// and the probe for a free trash name are unbounded in time and read the
// filesystem, so they run before that check and never between the check and the
// rename.
//
// Retention keeps current's target, the snapshot just published, and the 5
// newest snapshots. A candidate is re-resolved against current and then renamed
// into a trash name under one ownership check with nothing but the rename behind
// it; the trash name is deleted afterwards, when the published name is already
// gone and current cannot name it any more. A directory that cannot be removed is
// exactly one bounded warning and never fails the publication: current already
// points at a complete snapshot by then.
//
// External processes: git (the checkout identity and the committed file set are
// git's to decide) and nothing else. No cp, stat, flock, pax, perl, tr or mv is
// spawned; every filesystem operation is a Node call, so the behaviour is the
// same on Linux and macOS.

import { execFileSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { FatalError, die, lstatOrNull, msg, readlinkOrNull, warn } from "./io.mjs";

// Latest snapshots kept beyond current's target, as documented in the help text
// and the README; the number is a contract, not a tuning knob.
const KEEP = 5;

// extensions/subagents/index.ts marks a complete extensions/ tree: it ships in
// every host install and a copy without it is not an agent-kit extension set.
const EXT_MARKER = "extensions/subagents/index.ts";
const RUNTIME_PACKAGES = [
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-tui",
	"typebox",
];

const DEFAULT_LOCK_TIMEOUT_SECONDS = 60;
const LOCK_NAME = ".lock";
const CURRENT_NAME = "current";
const TMP_PREFIX = ".tmp-";
const TRASH_PREFIX = ".trash-";
const CURRENT_TMP_PREFIX = ".current.tmp-";
const SHA_NAME = /^[0-9a-f]{40}$/;

// The manifest shapes this writer reads: schema 2 is what it writes, schema 1 is
// what the pre-Node writer left behind. Reading is strict on purpose - a
// directory that merely contains the right sha somewhere is not a snapshot of
// that commit. The schema doubles as the writer's identity marker: only schema 2
// proves that node_modules inodes are independent of the checkout, because the
// Bash writer hardlinked them against the checkout even on the first sync.
// The source field is a JSON string: our escapes, or a \uXXXX escape, but no
// raw control character (a checkout path with a newline is escaped, not lost).
const SNAPSHOT_SCHEMA = 2;
const JSON_STRING_BODY = String.raw`(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*`;

function manifestPattern(schema) {
	return new RegExp(
		"^\\{\\n" +
			` {2}"schema": ${schema},\\n` +
			' {2}"sha": "([0-9a-f]{40})",\\n' +
			' {2}"dirty": (true|false),\\n' +
			' {2}"createdAt": "(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z)",\\n' +
			` {2}"source": "(${JSON_STRING_BODY})"\\n` +
			"\\}\\n$",
	);
}

// Newest shape first: a complete artifact is trusted according to the writer
// named by its schema.
const MANIFEST_SHAPES = [
	{ schema: 2, hardlinkSafe: true, pattern: manifestPattern(2) },
	{ schema: 1, hardlinkSafe: false, pattern: manifestPattern(1) },
];

// --- small primitives -------------------------------------------------------

function bounded(text, max = 120) {
	const oneLine = String(text).replace(/[\u0000-\u001f\u007f]/g, " ");
	return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine;
}

function isFile(path) {
	const stat = lstatOrNull(path);
	return stat?.isFile() === true;
}

// Synchronous sleep: the whole command is synchronous, and a lock waiter must
// not build a second control flow out of timers.
function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function token() {
	return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// A removal that starts from a writable tree: a copied 0555 directory cannot be
// descended into, so permissions are relaxed before the unlink. Returns false
// when something is still there afterwards.
//
// Nothing is removed under the name it is reachable by. The victim is first
// renamed in one syscall to a reserved trash name, and only that trash name is
// walked and deleted: a recursive removal is one syscall per entry, and while it
// runs another process can make the tree it walks current, so the name that
// current could name has to be gone before the walk starts. Publication never
// writes a reserved name (a snapshot is a 40-hex commit sha, current is a symlink
// to one), so the walk can only ever delete names current cannot use.
//
// The permission walk and the probe for a free trash name are as deep as the
// tree and as slow as the filesystem, and both read it, so both run before
// `commission`, never between it and the rename: a caller that must not remove on
// a lock it may have lost passes the ownership check as `commission` and has
// nothing but the one rename behind it.
//
// A path that is already a reserved name is deleted where it is. Such a name is
// not reachable by a publication (see the header), so no rename is needed to make
// it unreachable, and adding one prefix per attempt would grow a leftover that
// cannot be removed - permission, a busy entry - by a token per run until the name
// exceeds NAME_MAX and the leftover, now unreachable even for its own removal,
// stays on disk forever. Deleting it under its own name keeps the length it has.
//
// AGENT_KIT_SNAPSHOT_FAIL_REMOVE is a test seam and nothing else: it names a
// path fragment whose removal always reports failure, so the suite can observe
// the warning path on hosts where an unprivileged removal cannot be made to
// fail (the suite may run as root, and DAC does not stop root). It affects only
// the outcome of a removal, never the publication contract.
const FAIL_REMOVE = process.env.AGENT_KIT_SNAPSHOT_FAIL_REMOVE ?? "";

// A free reserved name next to the victim. The token makes a collision with
// another process practically impossible; the existence probe makes it
// impossible to reuse a leftover of a killed run. Null when the namespace around
// the victim is exhausted - a warning, never a publication failure.
function freeTrashPath(dir, name) {
	for (let attempt = 0; attempt < 16; attempt += 1) {
		const candidate = join(dir, `${TRASH_PREFIX}${token()}-${attempt}-${name}`);
		if (!lstatOrNull(candidate)) return candidate;
	}
	return null;
}

function removeTree(path, commission) {
	const stat = lstatOrNull(path);
	if (!stat) return true;
	if (FAIL_REMOVE !== "" && path.includes(FAIL_REMOVE)) return false;
	makeWritable(path);
	const name = basename(path);
	if (name.startsWith(TRASH_PREFIX)) {
		// Already reserved: nothing a publication can name, so it is deleted where
		// it is and its length never grows.
		if (commission) commission();
		return deleteReserved(path);
	}
	// The free-name probe reads the directory: it is part of the preparation and
	// runs before the commission, so the commission has nothing but the rename
	// behind it.
	const trash = freeTrashPath(dirname(path), name);
	if (trash === null) {
		warn(`snapshot: cannot find a free trash name next to ${bounded(path, 120)}; it stays on disk`);
		return false;
	}
	if (commission) commission();
	try {
		renameSync(path, trash);
	} catch (err) {
		// A name that vanished under this process is already removed; anything
		// else is a tree that stays on disk and is reported by the caller.
		if (err?.code === "ENOENT") return true;
		warn(
			`snapshot: could not move ${bounded(path, 120)} to ${bounded(trash, 120)}: ` +
				`${err?.code ?? err?.message}`,
		);
		return !lstatOrNull(path);
	}
	return deleteReserved(trash);
}

// Delete one reserved name. The published name is gone by the time this runs, so
// a leftover here is never a publication failure: it is reported and swept by the
// next run. Returns true - the caller's victim is unreachable either way.
function deleteReserved(path) {
	try {
		rmSync(path, { recursive: true, force: true });
	} catch {
		// Reported by the existence re-check below.
	}
	if (lstatOrNull(path)) {
		warn(`snapshot: could not remove the trash entry ${bounded(path, 120)}; the next run sweeps it`);
	}
	return true;
}

function makeWritable(path) {
	const stat = lstatOrNull(path);
	if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return;
	try {
		chmodSync(path, stat.mode | 0o700);
	} catch {
		// Best effort: the removal below reports what it could not do.
	}
	let entries;
	try {
		entries = readdirSync(path);
	} catch {
		return;
	}
	for (const entry of entries) makeWritable(join(path, entry));
}

// --- the checkout identity --------------------------------------------------

function gitOutput(repo, args) {
	try {
		return execFileSync("git", ["-C", repo, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch {
		return null;
	}
}

function git(repo, args) {
	const output = gitOutput(repo, args);
	return output === null ? null : output.trim();
}

// The committed tree is the snapshot's identity, so the checkout must be clean:
// uncommitted or untracked content has no commit sha to be published under.
function resolveHead(repo) {
	if (git(repo, ["rev-parse", "--git-dir"]) === null) {
		die(`snapshot: ${repo} is not a git checkout; there is no HEAD to snapshot`);
	}
	const branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (!branch || branch === "HEAD") {
		die(`snapshot: ${repo} is in detached HEAD state; switch to a branch first`);
	}
	const sha = git(repo, ["rev-parse", "--verify", "HEAD"]);
	if (!sha || !SHA_NAME.test(sha)) {
		die(`snapshot: could not resolve a full 40-character HEAD sha in ${repo}`);
	}
	const status = git(repo, ["status", "--porcelain", "--untracked-files=normal"]);
	if (status === null) {
		die(`snapshot: could not read the working tree state of ${repo}`);
	}
	if (status !== "") {
		const paths = status
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => bounded(line, 100));
		const shown = paths.slice(0, 5).join("; ");
		const more = paths.length > 5 ? ` (and ${paths.length - 5} more)` : "";
		die(
			`snapshot: ${repo} has ${paths.length} uncommitted path(s) and a snapshot is published as ${sha}, ` +
				`the committed tree; commit or stash first: ${shown}${more}`,
		);
	}
	return { sha };
}

// --- snapshot shape ---------------------------------------------------------

function hasPackages(nodeModules) {
	return RUNTIME_PACKAGES.every((name) => {
		const stat = lstatOrNull(join(nodeModules, name));
		return stat?.isDirectory() === true;
	});
}

function readManifest(path) {
	if (!isFile(path)) return null;
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	for (const shape of MANIFEST_SHAPES) {
		const match = shape.pattern.exec(text);
		if (!match) continue;
		return {
			schema: shape.schema,
			hardlinkSafe: shape.hardlinkSafe,
			sha: match[1],
			dirty: match[2] === "true",
			createdAt: match[3],
			source: match[4],
		};
	}
	return null;
}

// A directory under a final name is trusted only after this check. Every
// refusal has to say what is wrong, because the answer is "remove it by hand"
// and the operator needs to know which artifact is not ours.
function inspectSnapshot(dir, sha) {
	const stat = lstatOrNull(dir);
	if (!stat) return { ok: false, reason: "it does not exist" };
	if (!stat.isDirectory()) return { ok: false, reason: "it is not a directory" };
	if (!isFile(join(dir, EXT_MARKER))) return { ok: false, reason: `it lacks ${EXT_MARKER}` };
	if (!hasPackages(join(dir, "node_modules"))) {
		return {
			ok: false,
			reason: `its node_modules lacks ${RUNTIME_PACKAGES.join(", ")}`,
		};
	}
	const manifest = readManifest(join(dir, "manifest.json"));
	if (!manifest) {
		return { ok: false, reason: "its manifest.json is not a snapshot record this writer writes" };
	}
	if (manifest.sha !== sha) return { ok: false, reason: `its manifest describes ${manifest.sha}` };
	// Older versions snapshotted the working tree and recorded that in the
	// manifest. Such an artifact may contain anything, so it is neither reused
	// nor relabelled as a snapshot of the commit.
	if (manifest.dirty) {
		return {
			ok: false,
			reason: "it was written from a dirty working tree by an older agent-kit and is not the committed tree",
		};
	}
	// An artifact of the pre-Node writer is complete, but its node_modules can
	// still share inodes with a checkout. It may be reused as it is; it is never
	// the source of hardlinks for a new snapshot.
	return { ok: true, hardlinkSafe: manifest.hardlinkSafe, schema: manifest.schema };
}

// --- publishing -------------------------------------------------------------

function copyTree(src, dst, { dereference = false } = {}) {
	const stat = dereference ? statSync(src) : lstatSync(src);
	if (stat.isSymbolicLink()) {
		symlinkSync(readlinkSync(src), dst);
		return;
	}
	if (stat.isDirectory()) {
		// Created writable and narrowed afterwards: a 0555 source directory must
		// still accept the children that go into it. Timestamps are not
		// preserved - nothing reads them, and a snapshot's identity is its sha.
		mkdirSync(dst, { mode: 0o700 });
		for (const entry of readdirSync(src)) {
			copyTree(join(src, entry), join(dst, entry), { dereference });
		}
		chmodSync(dst, stat.mode & 0o7777);
		return;
	}
	if (stat.isFile()) {
		copyFileSync(src, dst);
		chmodSync(dst, stat.mode & 0o7777);
		return;
	}
	die(`snapshot: cannot copy ${src}: it is not a regular file or directory`);
}

// Hardlink copy for sources that never change again (published snapshots).
// Every file falls back to a real copy on its own, so one unsupported link
// (a different filesystem, a link limit, a permission) does not throw away the
// whole copy.
function linkTree(src, dst) {
	const stat = lstatSync(src);
	if (stat.isDirectory()) {
		mkdirSync(dst, { mode: 0o700 });
		for (const entry of readdirSync(src)) linkTree(join(src, entry), join(dst, entry));
		chmodSync(dst, stat.mode & 0o7777);
		return;
	}
	if (!stat.isFile()) {
		die(`snapshot: cannot link ${src}: a published snapshot holds only directories and files`);
	}
	try {
		linkSync(src, dst);
	} catch {
		copyFileSync(src, dst);
	}
	chmodSync(dst, stat.mode & 0o7777);
}

function currentTarget(releases) {
	const link = join(releases, CURRENT_NAME);
	if (lstatOrNull(link)?.isSymbolicLink() !== true) return null;
	const target = readlinkOrNull(link);
	if (!target) return null;
	return resolve(releases, target);
}

function nodeModulesSource(repo, releases) {
	const previous = currentTarget(releases);
	if (previous) {
		const check = inspectSnapshot(previous, basename(previous));
		if (check.ok && check.hardlinkSafe) {
			const nodeModules = join(previous, "node_modules");
			if (hasPackages(nodeModules)) return { path: nodeModules, hardlink: true };
		} else if (check.ok) {
			// A schema-1 snapshot was written by the pre-Node writer, which
			// hardlinked node_modules against the checkout. Hardlinking from it
			// would publish a snapshot that changes with the checkout, so the
			// runtime tree is copied from the checkout instead.
			warn(
				`snapshot: ${bounded(previous, 120)} was written by an older agent-kit, whose node_modules ` +
				`can share inodes with a checkout; copying node_modules from the checkout instead of hardlinking it`,
			);
		}
	}
	const nodeModules = join(repo, "node_modules");
	if (hasPackages(nodeModules)) return { path: nodeModules, hardlink: false };
	die(
		`snapshot: no node_modules source provides ${RUNTIME_PACKAGES.join(", ")} ` +
			`(looked at ${join(releases, CURRENT_NAME)} and ${nodeModules})`,
	);
}

// The committed file set of extensions/, as "<mode> <path>" records. git owns
// the composition: a file that the working tree holds but the commit does not
// (an ignored local extension, an untracked draft) is not part of the snapshot.
function committedExtensions(repo) {
	const raw = gitOutput(repo, ["ls-files", "--cached", "-z", "-s", "--", "extensions"]);
	if (raw === null) die(`snapshot: could not list the committed files of ${repo} under extensions`);
	const files = [];
	for (const record of raw.split("\0")) {
		if (record === "") continue;
		const split = record.indexOf("\t");
		const fields = split < 0 ? [] : record.slice(0, split).split(" ");
		if (fields.length !== 3) die("snapshot: could not parse the committed file list of extensions");
		const [mode, , stage] = fields;
		const path = record.slice(split + 1);
		if (stage !== "0") {
			die(`snapshot: ${bounded(path, 100)} has an unmerged index entry; resolve the merge first`);
		}
		files.push({ mode, path });
	}
	return files;
}

// Copy exactly that file set. Directory modes are taken from the checkout (git
// records no directory modes), file modes come from the commit's mode bits, and
// a symlink keeps the target the commit has because the tree is clean.
function copyCommittedExtensions(repo, dest, files) {
	const source = join(repo, "extensions");
	mkdirSync(dest, { mode: 0o700 });
	const directories = new Map();
	const ensureDirectory = (relative) => {
		let current = "";
		for (const segment of relative === "" ? [] : relative.split("/")) {
			current = current === "" ? segment : `${current}/${segment}`;
			if (directories.has(current)) continue;
			mkdirSync(join(dest, current), { mode: 0o700 });
			const stat = lstatOrNull(join(source, current));
			directories.set(current, stat?.isDirectory() ? stat.mode & 0o7777 : 0o777);
		}
	};
	for (const file of files) {
		if (!file.path.startsWith("extensions/")) {
			die(`snapshot: the committed path ${bounded(file.path, 100)} is not a file inside extensions/`);
		}
		const relative = file.path.slice("extensions/".length);
		const slash = relative.lastIndexOf("/");
		ensureDirectory(slash < 0 ? "" : relative.slice(0, slash));
		const from = join(repo, file.path);
		const to = join(dest, relative);
		if (file.mode === "160000") {
			die(`snapshot: ${bounded(file.path, 100)} is a git submodule; a snapshot cannot hold it`);
		}
		if (file.mode === "120000") {
			symlinkSync(readlinkSync(from), to);
			continue;
		}
		if (file.mode !== "100644" && file.mode !== "100755") {
			die(`snapshot: ${bounded(file.path, 100)} has git mode ${file.mode}, which a snapshot cannot copy`);
		}
		copyFileSync(from, to);
		chmodSync(to, file.mode === "100755" ? 0o755 : 0o644);
	}
	for (const [relative, mode] of directories) chmodSync(join(dest, relative), mode);
	const root = lstatOrNull(source);
	if (root?.isDirectory()) chmodSync(dest, root.mode & 0o7777);
}

function buildSnapshot(repo, releases, sha, tmp) {
	const extensions = committedExtensions(repo);
	if (!extensions.some((file) => file.path === EXT_MARKER)) {
		die(
			`snapshot: ${EXT_MARKER} is not committed at ${sha}; ` +
				`${join(repo, "extensions")} is not an agent-kit extension set`,
		);
	}
	mkdirSync(tmp);
	copyCommittedExtensions(repo, join(tmp, "extensions"), extensions);

	const source = nodeModulesSource(repo, releases);
	if (source.hardlink) linkTree(source.path, join(tmp, "node_modules"));
	else copyTree(source.path, join(tmp, "node_modules"), { dereference: true });

	const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
	const manifest =
		`{\n` +
		`  "schema": ${SNAPSHOT_SCHEMA},\n` +
		`  "sha": "${sha}",\n` +
		`  "dirty": false,\n` +
		`  "createdAt": "${createdAt}",\n` +
		`  "source": ${JSON.stringify(repo)}\n` +
		`}\n`;
	writeFileSync(join(tmp, "manifest.json"), manifest);
}

function publishSnapshot(releases, sha, tmp, commission) {
	const final = join(releases, sha);
	// rename(2) replaces a file or a symlink at the target silently; only a
	// non-empty directory is refused by the kernel. The type check makes that
	// refusal explicit instead of relying on the post-rename inspection.
	const existing = lstatOrNull(final);
	if (existing) {
		const kind = existing.isDirectory() ? "directory" : existing.isSymbolicLink() ? "symlink" : "file";
		die(`snapshot: ${final} exists as a ${kind}; move it out of the way and retry`);
	}
	// Everything the publication itself decides is settled above; the ownership
	// check is the last thing before the rename, so only the rename follows it.
	commission();
	try {
		renameSync(tmp, final);
	} catch (err) {
		if (err?.code === "ENOTEMPTY" || err?.code === "EEXIST" || err?.code === "ENOTDIR") {
			die(`snapshot: ${final} appeared while building ${tmp}; move it out of the way and retry`);
		}
		die(`snapshot: could not publish ${tmp} as ${final}: ${err?.code ?? err?.message}`);
	}
	const check = inspectSnapshot(final, sha);
	if (!check.ok) {
		die(`snapshot: ${final} is not a complete snapshot of ${sha} after publication (${check.reason}); remove it manually`);
	}
}

function flipCurrent(releases, sha, commission) {
	const link = join(releases, CURRENT_NAME);
	const existing = lstatOrNull(link);
	if (existing && existing.isSymbolicLink() !== true) {
		die(`snapshot: ${link} exists and is not a symlink; refusing to replace it`);
	}
	let tmp = null;
	for (let attempt = 0; attempt < 16 && tmp === null; attempt += 1) {
		const candidate = join(releases, `${CURRENT_TMP_PREFIX}${process.pid}-${token()}-${attempt}`);
		try {
			symlinkSync(sha, candidate);
			tmp = candidate;
		} catch (err) {
			if (err?.code !== "EEXIST") throw err;
		}
	}
	if (tmp === null) die(`snapshot: cannot create a temporary symlink next to ${link}`);
	// The temporary link is a name of this process's own; the flip itself is a
	// step another process can observe, so it is commissioned right before it.
	commission();
	try {
		renameSync(tmp, link);
	} catch (err) {
		try {
			// The one removal this writer performs without a trash name, and the
			// reason it is safe: tmp is a symlink this process created in its own
			// name namespace a moment ago, current can never name it, and unlinking
			// it removes the link itself, never the snapshot it points at. A leftover
			// of a killed run is a different case and is swept through the trash
			// namespace like everything else.
			unlinkSync(tmp);
		} catch {
			// The sweep of the next run removes it.
		}
		die(`snapshot: could not atomically replace ${link}: ${err?.code ?? err?.message}`);
	}
}

// --- retention --------------------------------------------------------------

function pruneSnapshots(releases, published, verifyLock) {
	const keep = join(releases, published);
	verifyLock("the retention prune");
	const candidates = [];
	for (const name of readdirSync(releases)) {
		if (!SHA_NAME.test(name)) continue;
		const path = join(releases, name);
		const stat = lstatOrNull(path);
		if (!stat?.isDirectory()) continue;
		candidates.push({ path, mtime: stat.mtimeMs });
	}
	candidates.sort((a, b) => (b.mtime - a.mtime) || (a.path < b.path ? 1 : a.path > b.path ? -1 : 0));

	const stale = [];
	let kept = 0;
	for (const candidate of candidates) {
		if (candidate.path === keep || candidate.path === currentTarget(releases)) continue;
		kept += 1;
		if (kept <= KEEP) continue;
		stale.push(candidate.path);
	}

	let protectedPath = "";
	let failedPath = "";
	for (const path of stale) {
		// current is re-resolved per directory: a snapshot retained as current's
		// target is never a candidate, and the check is cheap. The decision holds
		// up to the rename into a trash name - one syscall - because current can
		// only move while another process holds the lock, and the rename is
		// commissioned with this process's ownership as the last thing before it.
		// What follows the rename is the removal of the trash name, which current
		// can never name; that part needs neither a check nor a lock.
		if (path === keep || path === currentTarget(releases)) {
			if (protectedPath === "") protectedPath = path;
			continue;
		}
		if (removeTree(path, () => verifyLock(`the retention prune of ${basename(path)}`))) continue;
		if (failedPath === "") failedPath = path;
	}
	verifyLock("the end of the retention prune");
	if (protectedPath !== "") {
		warn(
			`snapshot: kept ${bounded(protectedPath, 120)} because it is current or the snapshot just published`,
		);
	}
	if (failedPath !== "") {
		warn(`snapshot: could not remove the old snapshot ${bounded(failedPath, 120)}; it stays on disk`);
	}
}

// --- the releases lock ------------------------------------------------------

function lockPath(releases) {
	return join(releases, LOCK_NAME);
}

function lockTimeoutMs() {
	const raw = process.env.AGENT_KIT_SNAPSHOT_LOCK_TIMEOUT ?? "";
	if (raw === "") return DEFAULT_LOCK_TIMEOUT_SECONDS * 1000;
	if (!/^[0-9]+$/.test(raw)) {
		die("snapshot: AGENT_KIT_SNAPSHOT_LOCK_TIMEOUT must be a whole number of seconds");
	}
	return Number(raw) * 1000;
}

function encodeOwner(record) {
	return JSON.stringify(record);
}

function decodeOwner(target) {
	if (typeof target !== "string") return null;
	try {
		const parsed = JSON.parse(target);
		if (typeof parsed?.pid !== "number" || typeof parsed?.host !== "string") return null;
		if (typeof parsed?.token !== "string" || typeof parsed?.started !== "number") return null;
		return parsed;
	} catch {
		return null;
	}
}

// A lock's owner is provably gone only when it ran on this host and its pid no
// longer exists. Everything else - another host, an unreadable record, a live
// pid - is treated as held, because taking a working lock is the failure that
// corrupts a releases dir.
function ownerIsGone(record) {
	if (record.host !== hostname()) return false;
	if (record.pid === process.pid) return false;
	try {
		process.kill(record.pid, 0);
		return false;
	} catch (err) {
		return err?.code === "ESRCH";
	}
}

function freeAsidePath(base) {
	for (let attempt = 0; attempt < 16; attempt += 1) {
		const candidate = `${base}-${token()}-${attempt}`;
		if (!lstatOrNull(candidate)) return candidate;
	}
	die(`snapshot: cannot find a free aside name next to ${base}`);
}

// A record that goes back under a lock this process does not own names the same
// owner with a fresh token. The owner lost the name for at least one syscall, so
// another process may have run a whole mutation in that window - flipped current,
// pruned the snapshot the owner is working on, removed the snapshot it is about
// to remove. A record the owner still matches would let it commission a step
// against a releases dir whose state it never saw; re-keyed, it fails its next
// ownership check and stops with a bounded refusal, which is the correct
// outcome - its world changed, so the operation restarts. Both restore paths use
// this: the takeover that put a displaced lock back, and the release that moved
// an instance aside although it was not its own.
function rekeyedRecord(landed) {
	const owner = decodeOwner(landed);
	return owner ? encodeOwner({ ...owner, token: token() }) : landed;
}

// Move one lock instance aside and decide from what actually landed there.
// rename(2) is the arbiter: exactly one waiter can move one instance away, so the
// record in the unique aside path is the lock this process really claimed, and a
// record read before the move proves nothing about it. Taking over is only
// allowed when the claimed owner is provably gone.
function takeOverLock(lock, measured) {
	// The measurement that justified this takeover can be stale by now: re-read
	// the record .lock names right now and act only on that instance.
	if (readlinkOrNull(lock) !== measured) return false;
	const aside = freeAsidePath(`${lock}.stale`);
	try {
		renameSync(lock, aside);
	} catch (err) {
		if (err?.code === "ENOENT") return false;
		die(`snapshot: could not take over the abandoned lock ${lock}: ${err?.code ?? err?.message}`);
	}
	const landed = readlinkOrNull(aside);
	const owner = decodeOwner(landed);
	if (owner && ownerIsGone(owner)) {
		try {
			unlinkSync(aside);
		} catch {
			// An aside of a provably abandoned lock is a leftover; the sweep
			// under the next lock removes it.
		}
		return true;
	}
	restoreDisplacedLock(lock, aside, landed);
	return false;
}

// Put a lock record back under a name this process does not hold, without
// replacing whatever took the name in the meantime. symlink(2) is the only claim
// that cannot destroy a lock: it fails with EEXIST, where rename(2) silently
// replaces. The caller decides what a collision means; this helper only reports
// it.
function putLockBack(lock, record) {
	if (record === null) return "unreadable";
	try {
		symlinkSync(record, lock);
	} catch (err) {
		if (err?.code === "EEXIST") return "taken";
		return `failed: ${err?.code ?? err?.message}`;
	}
	return "restored";
}

// Put back a lock this process moved aside although its owner is not provably
// gone. The freed name is restored by creating the symlink again, which fails
// with EEXIST instead of replacing a lock that a third process acquired in that
// window, so undoing the move can never destroy someone else's lock. When that
// third process has the name, the displaced lock is named in a bounded failure
// instead of being deleted.
//
// The record that goes back is NOT the displaced instance but the same owner with
// a fresh token (see rekeyedRecord): handing the old token back would let the
// displaced owner pass its next ownership check and commission a step against a
// releases dir that changed while it did not hold the lock.
function restoreDisplacedLock(lock, aside, landed) {
	const owner = decodeOwner(landed);
	const ownerText = owner ? `pid ${owner.pid} on ${owner.host}` : bounded(landed ?? "unreadable", 60);
	if (landed !== null) {
		const outcome = putLockBack(lock, rekeyedRecord(landed));
		if (outcome === "taken") {
			die(
				`snapshot: ${lock} changed hands while this process was taking it over; the displaced lock is at ${aside} ` +
					`(owner: ${ownerText}); stop that process or remove whichever lock is stale, then retry`,
			);
		}
		if (outcome !== "restored") {
			die(
				`snapshot: could not put the displaced lock ${aside} back under ${lock} (owner: ${ownerText}, ` +
					`${outcome}); move it back or remove it, then retry`,
			);
		}
		try {
			unlinkSync(aside);
		} catch {
			// The sweep under the next lock removes the duplicate.
		}
		return;
	}
	die(
		`snapshot: ${lock} was not a lock symlink when this process claimed it; the displaced entry is at ${aside} ` +
			`(${ownerText}); move it back or remove it, then retry`,
	);
}

function acquireLock(releases, timeoutMs) {
	const lock = lockPath(releases);
	const record = { pid: process.pid, host: hostname(), token: token(), started: Date.now() };
	const target = encodeOwner(record);
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			symlinkSync(target, lock);
			return { path: lock, target };
		} catch (err) {
			if (err?.code !== "EEXIST") {
				die(`snapshot: cannot create the lock ${lock}: ${err?.code ?? err?.message}`);
			}
		}
		const stat = lstatOrNull(lock);
		if (!stat) continue; // released between the failed create and this probe
		if (stat.isSymbolicLink() !== true) {
			// A regular file under this name is the flock file of the versions
			// that ran before snapshots moved to Node.js: it carries no owner
			// record, so it can never be attributed and never blocks a lock.
			if (stat.isFile()) {
				try {
					unlinkSync(lock);
				} catch (err) {
					die(
						`snapshot: could not remove the legacy lock file ${lock}: ${err?.code ?? err?.message}; ` +
							`remove it manually if no older agent-kit is running`,
					);
				}
				warn(`snapshot: removed the legacy lock file ${lock} (written before snapshots ran on Node.js)`);
				continue;
			}
			die(
				`snapshot: ${lock} exists and is not a lock this version can attribute; remove it manually if no snapshot is running`,
			);
		}
		const landed = readlinkOrNull(lock);
		if (!landed) continue;
		const owner = decodeOwner(landed);
		if (!owner) {
			die(
				`snapshot: the lock ${lock} has no readable owner record (${bounded(landed, 60)}); ` +
					`remove it manually if no snapshot is running`,
			);
		}
		if (ownerIsGone(owner)) {
			if (takeOverLock(lock, landed)) continue;
		}
		if (Date.now() >= deadline) {
			die(
				`snapshot: could not lock ${lock} in ${Math.round(timeoutMs / 1000)}s (another snapshot is running as pid ` +
					`${owner.pid} on ${owner.host}); retry later`,
			);
		}
		sleep(50);
	}
}

// A lock can be displaced by a takeover that raced it, so the holder re-reads
// its own record before every destructive section instead of writing to a
// releases dir it may no longer own.
function verifyLock(handle, section) {
	if (!handle) return;
	for (let attempt = 0; attempt < 40; attempt += 1) {
		if (readlinkOrNull(handle.path) === handle.target) return;
		sleep(25);
	}
	die(
		`snapshot: lost the lock ${handle.path} to another process before ${section}; ` +
			`stopping instead of writing to a releases dir this process does not lock`,
	);
}

// Release order, in this order for a reason: re-read the name (never act on a
// lock this process does not own) -> move the instance aside in one syscall that
// no other process can split -> decide from the record that actually landed in
// the aside -> delete only the instance whose record is this process's own. A
// record that is not ours belongs to whoever holds the name now: it is put back
// by creating the symlink, never by a rename, because the name may already
// belong to a third owner and a rename would replace that lock silently, and it
// goes back re-keyed for the reason rekeyedRecord() names - the owner of the
// displaced instance did not hold the name while another process could have
// changed the releases dir. The aside is unlinked only after the name is
// restored, so the displaced instance is never lost.
function releaseLock(handle) {
	if (!handle) return;
	if (readlinkOrNull(handle.path) !== handle.target) {
		warn(`snapshot: ${handle.path} is no longer owned by this process; leaving it in place`);
		return;
	}
	const aside = freeAsidePath(`${handle.path}.release`);
	try {
		renameSync(handle.path, aside);
	} catch (err) {
		warn(`snapshot: could not release the lock ${handle.path}: ${err?.code ?? err?.message}`);
		return;
	}
	const landed = readlinkOrNull(aside);
	if (landed !== handle.target) {
		// A lock this process did not create landed aside: put it back without
		// replacing a lock that took the name in the meantime, and re-keyed, so its
		// owner cannot commission the step it prepared before the name was taken
		// away from it.
		const outcome = putLockBack(handle.path, rekeyedRecord(landed));
		if (outcome === "taken") {
			warn(
				`snapshot: ${handle.path} changed hands while this process released it; ` +
					`the displaced lock is at ${aside}`,
			);
			return;
		}
		if (outcome !== "restored") {
			warn(
				`snapshot: ${handle.path} was replaced while this process released it and cannot be put back ` +
					`(${outcome}); the replacement is at ${aside}`,
			);
			return;
		}
		return;
	}
	try {
		unlinkSync(aside);
	} catch {
		warn(`snapshot: could not remove the released lock ${aside}; remove it manually`);
	}
}

// Leftovers a killed run cannot clean up itself: a temporary build tree, a
// temporary current link, a trash name whose removal was interrupted, a lock or
// lock aside of a process that is gone. This runs under the lock, so nothing here
// can belong to a live operation.
function sweepLeftovers(releases) {
	let entries;
	try {
		entries = readdirSync(releases);
	} catch {
		return;
	}
	const leftovers = entries.filter(
		(name) =>
			name.startsWith(TRASH_PREFIX) ||
			name.startsWith(TMP_PREFIX) ||
			name.startsWith(CURRENT_TMP_PREFIX) ||
			name.startsWith(`${LOCK_NAME}.stale-`) ||
			name.startsWith(`${LOCK_NAME}.release-`),
	);
	for (const name of leftovers) {
		const path = join(releases, name);
		if (!removeTree(path)) {
			warn(`snapshot: could not remove the leftover ${bounded(path, 120)}; remove it manually`);
		}
	}
}

// --- the command ------------------------------------------------------------

function resolveReleasesDir(argument) {
	try {
		mkdirSync(argument, { recursive: true });
	} catch (err) {
		die(`snapshot: cannot create releases dir ${argument}: ${err?.code ?? err?.message}`);
	}
	try {
		return realpathSync(argument);
	} catch {
		die(`snapshot: cannot resolve releases dir ${argument}`);
	}
}

// `<releases-dir>` is the only argument, so the releases dir is resolved before
// anything decides the snapshot's content: the lock lives there and has to be
// taken first. Everything that decides that content - HEAD, the cleanliness of
// the checkout and the committed file set - is read after the lock is held,
// never before a wait, so a waiter cannot publish a tree it has not looked at
// again. The one probe that runs earlier answers a setup error rather than a
// content question: a directory that is not a git checkout at all is refused
// before an empty releases dir is created for it.
export function snapshot(repo, args) {
	if (args.length !== 1 || args[0] === "") {
		die("snapshot takes exactly one argument: <releases-dir> (see: agent-kit help)");
	}
	if (git(repo, ["rev-parse", "--git-dir"]) === null) {
		die(`snapshot: ${repo} is not a git checkout; there is no HEAD to snapshot`);
	}
	const releases = resolveReleasesDir(args[0]);

	// The cleanup and the lock release are installed before the lock is taken: a
	// death inside lock acquisition must not leave the temporary tree behind.
	let tmp = "";
	let lock = null;
	const cleanup = () => {
		if (tmp !== "") {
			if (!removeTree(tmp)) {
				warn(`snapshot: could not remove the temporary directory ${bounded(tmp, 160)}; remove it manually`);
			}
			tmp = "";
		}
		releaseLock(lock);
		lock = null;
	};
	// A refusal or a failed build cleans up here. A signal does not: the command
	// is synchronous, so Node cannot run a handler while the copy holds the
	// stack, and a queued handler would only fire after the work it was meant to
	// interrupt. Installing one would therefore turn a hard stop into a late one;
	// the leftovers are the next run's job, exactly as after SIGKILL.
	process.on("exit", cleanup);

	try {
		lock = acquireLock(releases, lockTimeoutMs());
		sweepLeftovers(releases);

		// HEAD and the working-tree state belong to this critical section: whoever
		// waited for the lock may have waited through a commit or an edit.
		const head = resolveHead(repo);
		const final = join(releases, head.sha);
		const existing = lstatOrNull(final);
		if (existing) {
			const check = inspectSnapshot(final, head.sha);
			if (!check.ok) {
				die(
					`snapshot: ${final} exists but is not a complete snapshot of ${head.sha} (${check.reason}); remove it manually`,
				);
			}
			if (currentTarget(releases) !== final) {
				flipCurrent(releases, head.sha, () => verifyLock(lock, "repairing current"));
			}
			pruneSnapshots(releases, head.sha, (section) => verifyLock(lock, section));
			msg(`Snapshot ${head.sha} is already present (${final}); current points at it`);
			return 0;
		}

		// Read again immediately before the copy: the identity and the clean state
		// this snapshot is published under must be the ones the copy sees.
		const copyHead = resolveHead(repo);
		if (copyHead.sha !== head.sha) {
			die(
				`snapshot: HEAD moved from ${head.sha} to ${copyHead.sha} while the snapshot was prepared; retry`,
			);
		}
		tmp = join(releases, `${TMP_PREFIX}${copyHead.sha}-${process.pid}-${token()}`);
		buildSnapshot(repo, releases, copyHead.sha, tmp);
		publishSnapshot(releases, copyHead.sha, tmp, () => verifyLock(lock, "the publish rename"));
		tmp = "";
		flipCurrent(releases, copyHead.sha, () => verifyLock(lock, "the current flip"));
		// The flip comes first on purpose: retention must never leave current
		// pointing at what it is about to delete, and a prune failure is only a
		// warning.
		pruneSnapshots(releases, copyHead.sha, (section) => verifyLock(lock, section));
		msg(`Snapshot ${copyHead.sha} -> ${final} (current)`);
		return 0;
	} catch (err) {
		// Anything that is not an intended refusal still has to leave the CLI with
		// one bounded diagnostic line and the refusal exit status, never a stack.
		if (err instanceof FatalError) throw err;
		die(`snapshot: ${bounded(err?.message ?? String(err), 200)}`);
	} finally {
		cleanup();
		process.off("exit", cleanup);
	}
}
