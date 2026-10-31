// Test-only interposer for the snapshot suite's lock and identity races.
//
// NODE_OPTIONS="--require <this file>" installs a wrapper around the CLI's
// `fs.renameSync`, `fs.readlinkSync`, `fs.symlinkSync`, `fs.rmSync`,
// `fs.unlinkSync` and `fs.chmodSync` bindings, so a test can freeze the writer
// at a named point for exactly as long as it needs and then drive the next step
// from the test. It is a harness for tests/snapshot/run.sh: the CLI never loads
// it on its own, and nothing here is part of the command contract.
//
// AGENT_KIT_SNAPSHOT_TEST_PAUSE is a ";"-separated list of
//   <point>:<ready-file>:<release-file>
// Every point fires at most once per process. At a point the interposer writes
// <ready-file> and then waits until the test creates <release-file>; the wait is
// bounded (60 s) so a broken test cannot hang the suite.
//
// Points:
//   lock-read     after readlink("<releases>/.lock") returned its owner
//                 record: the record has been read, nothing changed yet
//   claim-before  before rename("<releases>/.lock", "<releases>/.lock.stale-*")
//   claim-after   after that rename returned: one lock instance has been
//                 claimed, and the claimer has not looked at it yet
//   lock-create   after symlink("<releases>/.lock") returned: the process has
//                 published its own owner record, nothing else happened yet
//   prune-remove  at the first chmod of a snapshot directory
//                 (<releases>/<40-hex>) performed by removeTree()'s permission
//                 walk: every ownership and current check the writer made for
//                 that retention candidate has returned, the removal has not
//                 started, and the walk is the last thing the writer does to the
//                 tree before it renames the directory into the trash namespace
//   claim-restore after a takeover re-read the record it actually moved aside
//                 and before it either discards that instance or puts a record
//                 back under <releases>/.lock
//   release-before
//                 before releaseLock() moves its own lock aside
//   release-restore
//                 before releaseLock() hands a lock it displaced but does not own
//                 back under <releases>/.lock: the name is free at that moment
//   trash-remove  before the recursive removal of a reserved trash name: the
//                 victim's published name is already gone, and what is left to
//                 walk is a name `current` can never be written with
//
// Points that are about a writer's own step ("prune-remove", "claim-restore",
// "release-*") are selected by the caller frames named in the point, not by the
// ordinal of a syscall, so a refactor that adds or drops an unrelated call does
// not move them. A point that never fires is a failed test, never a silent pass.
//
// AGENT_KIT_SNAPSHOT_TEST_TRACE names a file that receives one line per
// removal-shaped syscall the writer performs: `rmSync <path>`,
// `unlinkSync <path>` and `renameSync <from> -> <to>`. The suite reads it to
// assert *where* a removal happens, not just that it happened.
//
// Paths in the spec cannot contain ":" (the sandbox paths never do).

"use strict";

const fs = require("node:fs");

const points = new Map();
for (const spec of (process.env.AGENT_KIT_SNAPSHOT_TEST_PAUSE ?? "").split(";")) {
	if (spec === "") continue;
	const parts = spec.split(":");
	if (parts.length !== 3) continue;
	points.set(parts[0], { ready: parts[1], release: parts[2], fired: false });
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function hold(point) {
	const entry = points.get(point);
	if (!entry || entry.fired) return;
	entry.fired = true;
	fs.writeFileSync(entry.ready, "");
	const deadline = Date.now() + 60000;
	while (Date.now() < deadline && !fs.existsSync(entry.release)) {
		Atomics.wait(sleepCell, 0, 0, 20);
	}
}

const isLock = (path) => String(path).endsWith("/.lock");

const SNAPSHOT_NAME = /^[0-9a-f]{40}$/;

// A snapshot directory, the only thing retention removes as a unit.
function isSnapshotEntry(path) {
	const parts = String(path).split("/");
	return SNAPSHOT_NAME.test(parts[parts.length - 1] ?? "");
}

// True when every named function is on the current call chain. The writer's
// functions are named, so this ties a point to the step it describes instead of
// to a syscall count.
function inFrame(...names) {
	const stack = new Error().stack ?? "";
	return names.every((name) => stack.includes(`at ${name} `));
}

const TRACE = process.env.AGENT_KIT_SNAPSHOT_TEST_TRACE ?? "";

function trace(line) {
	if (TRACE === "") return;
	fs.appendFileSync(TRACE, `${line}\n`);
}

const renameSync = fs.renameSync;
fs.renameSync = function pauseRename(oldPath, newPath) {
	trace(`renameSync ${oldPath} -> ${newPath}`);
	const claim = isLock(oldPath) && String(newPath).includes(".lock.stale");
	if (claim) hold("claim-before");
	const release = isLock(oldPath) && String(newPath).includes(".lock.release");
	if (release) hold("release-before");
	// The release path of a writer without a non-replacing hand-back puts the
	// displaced record back by rename; the point describes that step, not the
	// syscall that happens to implement it.
	if (isLock(newPath) && !isLock(oldPath) && inFrame("releaseLock")) hold("release-restore");
	const result = renameSync.apply(fs, arguments);
	if (claim) hold("claim-after");
	return result;
};

const symlinkSync = fs.symlinkSync;
fs.symlinkSync = function pauseSymlink(target, path) {
	if (isLock(path) && inFrame("putLockBack", "releaseLock")) hold("release-restore");
	const result = symlinkSync.apply(fs, arguments);
	if (isLock(path)) hold("lock-create");
	return result;
};

const TRASH_NAME = /\/\.trash-/;

const rmSync = fs.rmSync;
fs.rmSync = function traceRm(path) {
	trace(`rmSync ${path}`);
	if (TRASH_NAME.test(String(path)) && inFrame("removeTree")) hold("trash-remove");
	return rmSync.apply(fs, arguments);
};

const unlinkSync = fs.unlinkSync;
fs.unlinkSync = function traceUnlink(path) {
	trace(`unlinkSync ${path}`);
	return unlinkSync.apply(fs, arguments);
};

const chmodSync = fs.chmodSync;
fs.chmodSync = function pauseChmod(path) {
	// A retention removal is a walk over the tree followed by the unlink; the
	// walk's first chmod is the last moment before the unlink that can still be
	// interrupted from outside.
	if (
		points.has("prune-remove") &&
		isSnapshotEntry(path) &&
		inFrame("removeTree", "makeWritable")
	) {
		hold("prune-remove");
	}
	return chmodSync.apply(fs, arguments);
};

const readlinkSync = fs.readlinkSync;
fs.readlinkSync = function pauseReadlink(path) {
	const result = readlinkSync.apply(fs, arguments);
	if (isLock(path)) hold("lock-read");
	if (String(path).includes(".lock.stale") && inFrame("takeOverLock")) hold("claim-restore");
	return result;
};
