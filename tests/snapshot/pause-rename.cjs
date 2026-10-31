// Test-only interposer for the snapshot suite's lock and identity races.
//
// NODE_OPTIONS="--require <this file>" installs a wrapper around the CLI's
// `fs.renameSync`, `fs.readlinkSync` and `fs.symlinkSync` bindings, so a test
// can freeze the writer at a named point for exactly as long as it needs and
// then drive the next step from the test. It is a harness for
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

const readlinkSync = fs.readlinkSync;
fs.readlinkSync = function pauseReadlink(path) {
	const result = readlinkSync.apply(fs, arguments);
	if (isLock(path)) hold("lock-read");
	return result;
};
