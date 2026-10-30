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
// relabelled.
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
// Content: extensions/ is a real copy (symlinks preserved, modes preserved).
// node_modules/ is hardlinked from the previous complete snapshot - a published
// snapshot is never rewritten in place, so sharing those inodes is safe - or
// really copied from the checkout on the first sync. A checkout's node_modules
// is never hardlinked: the checkout keeps changing, and a shared inode would
// change a published snapshot with it.
//
// Locking: every operation on one releases dir runs under one exclusive lock,
// <releases>/.lock, created as a symlink whose target is the owner record
// (pid, host, token, start time). Creating a symlink publishes the lock and its
// owner in one atomic syscall, so a lock never exists without an owner record.
// The lock is released by moving it aside and re-reading what landed there, so
// a lock this process does not own is never deleted. A lock is taken over only
// when its recorded owner is provably gone: same host and a pid that no longer
// exists. Age is not evidence - a slow but live snapshot keeps its lock, and a
// lock that cannot be attributed is a bounded error naming its owner instead of
// a stolen lock. A recycled pid makes a dead owner look alive, which fails in
// the safe direction (bounded error, no takeover). Waiters poll boundedly
// (60 s default, AGENT_KIT_SNAPSHOT_LOCK_TIMEOUT overrides it).
//
// Retention keeps current's target, the snapshot just published, and the 5
// newest snapshots. A directory that cannot be removed is exactly one bounded
// warning and never fails the publication: current already points at a complete
// snapshot by then.
//
// External processes: git (the checkout identity is git's to decide) and
// nothing else. No cp, stat, flock, pax, perl, tr or mv is spawned; every
// filesystem operation is a Node call, so the behaviour is the same on Linux
// and macOS.

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
import { basename, join, resolve } from "node:path";
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
const CURRENT_TMP_PREFIX = ".current.tmp-";
const SHA_NAME = /^[0-9a-f]{40}$/;

// The manifest shape every version of this writer emits: exactly five fields,
// one per line, in this order. Reading is strict on purpose - a directory that
// merely contains the right sha somewhere is not a snapshot of that commit.
// The source field is a JSON string: our escapes, or a \uXXXX escape, but no
// raw control character (a checkout path with a newline is escaped, not lost).
const JSON_STRING_BODY = String.raw`(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*`;
const MANIFEST_PATTERN = new RegExp(
	"^\\{\\n" +
		' {2}"schema": 1,\\n' +
		' {2}"sha": "([0-9a-f]{40})",\\n' +
		' {2}"dirty": (true|false),\\n' +
		' {2}"createdAt": "(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z)",\\n' +
		` {2}"source": "(${JSON_STRING_BODY})"\\n` +
		"\\}\\n$",
);

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

// A rewrite-free removal that starts from a writable tree: a copied 0555
// directory cannot be descended into, so permissions are relaxed before the
// unlink. Returns false when something is still there afterwards.
//
// AGENT_KIT_SNAPSHOT_FAIL_REMOVE is a test seam and nothing else: it names a
// path fragment whose removal always reports failure, so the suite can observe
// the warning path on hosts where an unprivileged removal cannot be made to
// fail (the suite may run as root, and DAC does not stop root). It affects only
// the outcome of a removal, never the publication contract.
const FAIL_REMOVE = process.env.AGENT_KIT_SNAPSHOT_FAIL_REMOVE ?? "";

function removeTree(path) {
	const stat = lstatOrNull(path);
	if (!stat) return true;
	if (FAIL_REMOVE !== "" && path.includes(FAIL_REMOVE)) return false;
	makeWritable(path);
	try {
		rmSync(path, { recursive: true, force: true });
	} catch {
		// Reported by the existence re-check: the caller decides whether an
		// undeletable tree is a warning or a failure.
	}
	return !lstatOrNull(path);
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

function git(repo, args) {
	try {
		return execFileSync("git", ["-C", repo, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
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
	const match = MANIFEST_PATTERN.exec(text);
	if (!match) return null;
	return {
		sha: match[1],
		dirty: match[2] === "true",
		createdAt: match[3],
		source: match[4],
	};
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
	if (!manifest) return { ok: false, reason: "its manifest.json is not the expected five-field record" };
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
	return { ok: true };
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
	if (previous && inspectSnapshot(previous, basename(previous)).ok) {
		const nodeModules = join(previous, "node_modules");
		if (hasPackages(nodeModules)) return { path: nodeModules, hardlink: true };
	}
	const nodeModules = join(repo, "node_modules");
	if (hasPackages(nodeModules)) return { path: nodeModules, hardlink: false };
	die(
		`snapshot: no node_modules source provides ${RUNTIME_PACKAGES.join(", ")} ` +
			`(looked at ${join(releases, CURRENT_NAME)} and ${nodeModules})`,
	);
}

function buildSnapshot(repo, releases, sha, tmp) {
	if (!isFile(join(repo, EXT_MARKER))) {
		die(
			`snapshot: ${join(repo, EXT_MARKER)} is missing; ${join(repo, "extensions")} ` +
				`is not an agent-kit extension set`,
		);
	}
	mkdirSync(tmp);
	copyTree(join(repo, "extensions"), join(tmp, "extensions"));

	const source = nodeModulesSource(repo, releases);
	if (source.hardlink) linkTree(source.path, join(tmp, "node_modules"));
	else copyTree(source.path, join(tmp, "node_modules"), { dereference: true });

	const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
	const manifest =
		`{\n` +
		`  "schema": 1,\n` +
		`  "sha": "${sha}",\n` +
		`  "dirty": false,\n` +
		`  "createdAt": "${createdAt}",\n` +
		`  "source": ${JSON.stringify(repo)}\n` +
		`}\n`;
	writeFileSync(join(tmp, "manifest.json"), manifest);
}

function publishSnapshot(releases, sha, tmp) {
	const final = join(releases, sha);
	// rename(2) replaces a file or a symlink at the target silently; only a
	// non-empty directory is refused by the kernel. The type check makes that
	// refusal explicit instead of relying on the post-rename inspection.
	const existing = lstatOrNull(final);
	if (existing) {
		const kind = existing.isDirectory() ? "directory" : existing.isSymbolicLink() ? "symlink" : "file";
		die(`snapshot: ${final} exists as a ${kind}; move it out of the way and retry`);
	}
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

function flipCurrent(releases, sha) {
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
	try {
		renameSync(tmp, link);
	} catch (err) {
		try {
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
		// The permission walk runs before the ownership re-check, so only the
		// comparison and one unlink run after it.
		makeWritable(path);
		verifyLock(`the retention prune of ${basename(path)}`);
		// current is re-resolved per directory: a snapshot retained as current's
		// target is never a candidate, and the check is cheap.
		if (path === currentTarget(releases) || path === keep) {
			if (protectedPath === "") protectedPath = path;
			continue;
		}
		if (removeTree(path)) continue;
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

// Move the lock aside and hand it back when what landed there is not the lock
// this process measured as abandoned. rename(2) is the arbiter: exactly one
// waiter can move one lock instance away.
function takeOverLock(lock, measured) {
	const aside = freeAsidePath(`${lock}.stale`);
	try {
		renameSync(lock, aside);
	} catch (err) {
		if (err?.code === "ENOENT") return false;
		die(`snapshot: could not take over the stale lock ${lock}: ${err?.code ?? err?.message}`);
	}
	const landed = readlinkOrNull(aside);
	if (landed !== measured) {
		// Not the lock this process measured: put it back. A third acquirer that
		// took the freed name meanwhile is a loud, bounded failure, never a
		// silent second holder.
		if (!lstatOrNull(lock)) {
			try {
				renameSync(aside, lock);
				return false;
			} catch {
				// Fall through to the bounded error below.
			}
		}
		const owner = decodeOwner(landed);
		const ownerText = owner ? `pid ${owner.pid} on ${owner.host}` : bounded(landed ?? "unknown", 60);
		die(
			`snapshot: could not put the displaced lock back under ${lock}: another process acquired that name meanwhile; ` +
				`the displaced live lock is at ${aside} (owner: ${ownerText}); stop it or remove whichever lock is stale, then retry`,
		);
	}
	try {
		unlinkSync(aside);
	} catch {
		// An aside symlink that cannot be removed is a leftover of a lock that
		// was provably abandoned; the next sweep reports it.
	}
	return true;
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
	if (readlinkOrNull(aside) !== handle.target) {
		// A lock this process did not create landed aside: put it back.
		if (!lstatOrNull(handle.path)) {
			try {
				renameSync(aside, handle.path);
				return;
			} catch {
				// Reported below.
			}
		}
		warn(`snapshot: ${handle.path} was replaced while this process released it; the replacement is at ${aside}`);
		return;
	}
	try {
		unlinkSync(aside);
	} catch {
		warn(`snapshot: could not remove the released lock ${aside}; remove it manually`);
	}
}

// Leftovers a killed run cannot clean up itself: a temporary build tree, a
// temporary current link, a lock or lock aside of a process that is gone. This
// runs under the lock, so nothing here can belong to a live operation.
function sweepLeftovers(releases) {
	let entries;
	try {
		entries = readdirSync(releases);
	} catch {
		return;
	}
	const leftovers = entries.filter(
		(name) =>
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

export function snapshot(repo, args) {
	if (args.length !== 1 || args[0] === "") {
		die("snapshot takes exactly one argument: <releases-dir> (see: agent-kit help)");
	}
	const { sha } = resolveHead(repo);
	const releases = resolveReleasesDir(args[0]);
	const final = join(releases, sha);

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

		const existing = lstatOrNull(final);
		if (existing) {
			const check = inspectSnapshot(final, sha);
			if (!check.ok) {
				die(`snapshot: ${final} exists but is not a complete snapshot of ${sha} (${check.reason}); remove it manually`);
			}
			verifyLock(lock, "repairing current");
			if (currentTarget(releases) !== final) flipCurrent(releases, sha);
			pruneSnapshots(releases, sha, (section) => verifyLock(lock, section));
			msg(`Snapshot ${sha} is already present (${final}); current points at it`);
			return 0;
		}

		tmp = join(releases, `${TMP_PREFIX}${sha}-${process.pid}-${token()}`);
		buildSnapshot(repo, releases, sha, tmp);
		verifyLock(lock, "the publish rename");
		publishSnapshot(releases, sha, tmp);
		tmp = "";
		verifyLock(lock, "the current flip");
		flipCurrent(releases, sha);
		// The flip comes first on purpose: retention must never leave current
		// pointing at what it is about to delete, and a prune failure is only a
		// warning.
		pruneSnapshots(releases, sha, (section) => verifyLock(lock, section));
		msg(`Snapshot ${sha} -> ${final} (current)`);
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
