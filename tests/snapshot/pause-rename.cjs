// Test-only interposer for the snapshot suite's lock and identity races.
//
// NODE_OPTIONS="--require <this file>" installs a wrapper around the CLI's
// `fs.renameSync`, `fs.readlinkSync`, `fs.symlinkSync` and `fs.chmodSync`
// bindings, so a test can freeze the writer at a named point for exactly as long
// as it needs and then drive the next step from the test. It is a harness for
// tests/snapshot/run.sh: the CLI never loads it on its own, and nothing here is
// part of the command contract.
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
//                 tree before the unlink
//
// Points that are about a writer's own step ("prune-remove") are selected by the
// caller frames named in the point, not by the ordinal of a syscall, so a
// refactor that adds or drops an unrelated call does not move them. A point that
// never fires is a failed test, never a silent pass.
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

const renameSync = fs.renameSync;
fs.renameSync = function pauseRename(oldPath, newPath) {
	const claim = isLock(oldPath) && String(newPath).includes(".lock.stale");
	if (claim) hold("claim-before");
	const result = renameSync.apply(fs, arguments);
	if (claim) hold("claim-after");
	return result;
};

const symlinkSync = fs.symlinkSync;
fs.symlinkSync = function pauseSymlink(target, path) {
	const result = symlinkSync.apply(fs, arguments);
	if (isLock(path)) hold("lock-create");
	return result;
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
	return result;
};
