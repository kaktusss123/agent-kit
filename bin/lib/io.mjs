// Output and filesystem primitives shared by the installer commands.
//
// The CLI contract has exactly three channels: informational lines on stdout,
// `warning:` on stderr and `error:` on stderr with exit code 2. `die` raises a
// FatalError instead of exiting, so a refusal can be raised from any depth and
// still surface as one line of diagnostics rather than a stack trace.
//
// Stdout is written with a synchronous write on purpose: messages and warnings
// for one operation are ordered by call order, which a buffered stream would
// not guarantee when output goes to a pipe.

import { spawn } from "node:child_process";
import {
	lstatSync,
	mkdirSync,
	readlinkSync,
	renameSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname } from "node:path";

export class FatalError extends Error {
	constructor(message, exitCode = 2) {
		super(message);
		this.name = "FatalError";
		this.exitCode = exitCode;
	}
}

export function writeStdout(text) {
	try {
		writeSync(1, text);
	} catch (err) {
		// A closed consumer (`agent-kit status | head -1`) is a normal end of
		// output for a shell pipeline; mirror the shell's SIGPIPE status.
		if (err?.code === "EPIPE") process.exit(141);
		throw err;
	}
}

export function msg(text = "") {
	writeStdout(`${text}\n`);
}

export function writeStderr(text) {
	try {
		writeSync(2, text);
	} catch (err) {
		if (err?.code === "EPIPE") return;
		throw err;
	}
}

export function warn(text) {
	writeStderr(`warning: ${text}\n`);
}

export function die(text) {
	throw new FatalError(text);
}

// --- filesystem probes ------------------------------------------------------
//
// The installer distinguishes "exists", "exists as a symlink" and "does not
// exist at all" (a dangling symlink still exists and is still ours to judge),
// so probes never follow a final symlink unless the caller asks for it.

export function lstatOrNull(path) {
	try {
		return lstatSync(path);
	} catch {
		return null;
	}
}

export function statOrNull(path) {
	try {
		return statSync(path);
	} catch {
		return null;
	}
}

export function readlinkOrNull(path) {
	try {
		return readlinkSync(path);
	} catch {
		return null;
	}
}

// Atomic replacement of a small state file: write a sibling temporary file,
// then rename it over the destination. A crash leaves either the previous file
// or the complete new one, never a truncated record that could be read as
// ownership evidence.
export function writeFileAtomic(file, content) {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, content);
	renameSync(tmp, file);
}

// Run a child with the caller's stdio and translate its termination into a
// process exit status the way a shell would: the child's own code, or 128 plus
// the signal number when it was killed.
//
// The child is not the process, so termination signals are forwarded to it and
// the caller waits for its exit. Without that, a hook timeout or an interrupt
// would end the wrapper while the runtime it started keeps running.
export function runChild(command, args, options = {}) {
	const forwarded = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: "inherit",
			env: options.env ?? process.env,
		});
		const forward = (signal) => {
			if (child.exitCode === null && child.signalCode === null) child.kill(signal);
		};
		for (const signal of forwarded) process.on(signal, forward);
		const done = () => {
			for (const signal of forwarded) process.off(signal, forward);
		};
		child.on("error", (err) => {
			done();
			if (err.code === "ENOENT") reject(new FatalError(`cannot run ${command}: not found on PATH`));
			else reject(new FatalError(`cannot run ${command}: ${err.message}`));
		});
		child.on("close", (code, signal) => {
			done();
			if (signal) resolve(128 + (osConstants.signals[signal] ?? 0));
			else resolve(code ?? 1);
		});
	});
}
