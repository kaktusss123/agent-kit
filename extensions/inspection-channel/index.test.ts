import { describe, test } from "node:test";
import { createRequire } from "node:module";
import { expect } from "../../tests/support/expect.ts";

const require = createRequire(import.meta.url);
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { frameJsonLines, handleInspectionRequest, startInheritedChannel, validateInheritedFd, validateInheritedFdPair, validateRequest, waitForDrain } from "./index.ts";
import { inspectionRegistry } from "../subagents/inspection-seam.ts";

const deps = { cwd: process.cwd(), inspect: () => [{ id: "sa-1", state: "running" }] };

const hasMkfifo = (() => {
	if (process.platform === "win32") return false;
	const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "inspection-mkfifo-probe-"));
	try {
		return spawnSync("mkfifo", [path.join(probeDir, "probe.fifo")], { stdio: "ignore" }).status === 0;
	} finally {
		fs.rmSync(probeDir, { recursive: true, force: true });
	}
})();

const fifoChildScript = `
const fs = require("node:fs");
const [requestPath, responsePath] = process.argv.slice(2);
// Blocking open: parks until the parent opens the request fifo for reading.
const requestFd = fs.openSync(requestPath, fs.constants.O_WRONLY);
fs.writeSync(requestFd, JSON.stringify({ v: 1, id: "fifo-pair", op: "snapshot", area: "subagents" }) + "\\n");
fs.closeSync(requestFd);
// Blocking open: parks until the parent opens the response fifo for writing.
const responseFd = fs.openSync(responsePath, fs.constants.O_RDONLY);
let input = "";
const chunk = Buffer.alloc(1024);
while (!input.includes("\\n")) {
	const count = fs.readSync(responseFd, chunk, 0, chunk.length, null);
	if (count === 0) process.exit(2);
	input += chunk.toString("utf8", 0, count);
}
fs.closeSync(responseFd);
process.stdout.write(input);
process.exit(0);
`;

describe("inherited inspection protocol", () => {
	test("returns versioned bounded snapshots for each area", async () => {
		expect(await handleInspectionRequest('{"v":1,"id":"a","op":"snapshot","area":"subagents"}', deps)).toEqual({
			v: 1, id: "a", ok: true, result: { v: 1, area: "subagents", data: { agents: [{ id: "sa-1", state: "running" }] } },
		});
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "inspection-task-"));
		const previous = process.env.AGENT_TASK_ROOT;
		process.env.AGENT_TASK_ROOT = root;
		try {
			const task = await handleInspectionRequest('{"v":1,"id":"b","op":"snapshot","area":"task"}', deps);
			expect(task).toMatchObject({ v: 1, id: "b", ok: true, result: { v: 1, area: "task", data: { task: { current: { state: "none", repos: [] } } } } });
			const scoped = await handleInspectionRequest('{"v":1,"id":"c","op":"snapshot","area":"task_current"}', { ...deps, branchEntries: () => [] });
			expect(scoped).toMatchObject({ v: 1, id: "c", ok: true, result: { v: 1, area: "task_current", data: { task: { current: { state: "none", identity: null, repos: [] } } } } });
		} finally {
			if (previous === undefined) delete process.env.AGENT_TASK_ROOT;
			else process.env.AGENT_TASK_ROOT = previous;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("task projection is disabled while unbound and branch read errors propagate", async () => {
		const prior = inspectionRegistry.session;
		const priorCwd = inspectionRegistry.cwd;
		try {
			inspectionRegistry.session = undefined;
			inspectionRegistry.cwd = process.cwd();
			const unbound = await handleInspectionRequest('{"v":1,"id":"u","op":"snapshot","area":"task_current"}', deps);
			expect(unbound).toMatchObject({ ok: true, result: { data: { task: { current: { state: "none", identity: null } } } } });
			const failed = await handleInspectionRequest('{"v":1,"id":"e","op":"snapshot","area":"task_current"}', { ...deps, branchEntries: () => { throw new Error("history unavailable"); } });
			expect(failed).toMatchObject({ ok: false, error: { code: "snapshot_failed" } });
		} finally {
			inspectionRegistry.session = prior;
			inspectionRegistry.cwd = priorCwd;
		}
	});

	test("rejects malformed, unknown and invalid requests without throwing", async () => {
		expect(await handleInspectionRequest("not-json", deps)).toMatchObject({ ok: false, error: { code: "malformed_json" } });
		expect(await handleInspectionRequest('{"v":2,"id":"x","op":"snapshot","area":"all"}', deps)).toMatchObject({ ok: false, error: { code: "unknown_version" } });
		expect(await handleInspectionRequest('{"v":1,"id":"x","op":"nope","area":"all"}', deps)).toMatchObject({ ok: false, error: { code: "unknown_op" } });
		expect(validateRequest({ v: 1, id: "x", op: "snapshot", area: "nope" })).toMatchObject({ error: { code: "unknown_area" } });
		expect(validateRequest({ v: 1, id: "x", op: "snapshot", area: "task_current" })).toMatchObject({ request: { area: "task_current" } });
	});

	test("descriptor validation rejects standard streams, malformed and absent descriptors", () => {
		expect(validateInheritedFd(undefined)).toBeUndefined();
		expect(validateInheritedFd("1.5")).toBeUndefined();
		expect(validateInheritedFd("999999")).toBeUndefined();
		const regularFileFd = fs.openSync(process.execPath, "r");
		try { expect(validateInheritedFd(String(regularFileFd))).toBeUndefined(); }
		finally { fs.closeSync(regularFileFd); }
		for (const fd of ["0", "1", "2"]) expect(validateInheritedFd(fd)).toBeUndefined();
		expect(validateInheritedFdPair("3", "3")).toBeUndefined();
		expect(validateInheritedFdPair("0", "4")).toBeUndefined();
		expect(validateInheritedFdPair("4", "1")).toBeUndefined();
	});

	// A child writing on fd 3 and reading on fd 4 is the shape the production
	// host gives the agent (real inherited descriptors). Node's spawn pipes
	// are non-blocking, so the parent-side descriptors here come from a fifo
	// pair opened O_RDWR: a blocking descriptor keeps the fs streams from
	// failing with EAGAIN, and the child still receives fds 3 and 4.
	const inheritedStdioChildScript = `
		const fs = require("node:fs");
		fs.writeSync(3, JSON.stringify({ v: 1, id: "child-pair", op: "snapshot", area: "subagents" }) + "\\n");
		let input = "";
		const chunk = Buffer.alloc(1024);
		while (!input.includes("\\n")) {
			const count = fs.readSync(4, chunk, 0, chunk.length, null);
			if (count === 0) process.exit(2);
			input += chunk.toString("utf8", 0, count);
		}
		process.stdout.write(input);
	`;

	test("accepts and uses a real inherited bidirectional descriptor pair", { skip: !hasMkfifo }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inspection-pair-"));
		const requestPath = path.join(dir, "request.fifo");
		const responsePath = path.join(dir, "response.fifo");
		expect(spawnSync("mkfifo", [requestPath, responsePath], { stdio: "ignore" }).status).toBe(0);
		const requestRw = fs.openSync(requestPath, fs.constants.O_RDWR);
		const responseRw = fs.openSync(responsePath, fs.constants.O_RDWR);
		const child = spawn(process.execPath, ["-e", inheritedStdioChildScript], {
			stdio: ["ignore", "pipe", "inherit", requestRw, responseRw],
		});
		// The child holds the write end of `request` and the read end of
		// `response`, so these opens return at once. Dropping the read-write
		// descriptors leaves the parent with a read end that reaches EOF when
		// the child exits — a read-write descriptor would keep the fifo open
		// and park the channel's read forever.
		const requestFd = fs.openSync(requestPath, fs.constants.O_RDONLY);
		const responseFd = fs.openSync(responsePath, fs.constants.O_WRONLY);
		fs.closeSync(requestRw);
		fs.closeSync(responseRw);
		try {
			expect(validateInheritedFdPair(String(requestFd), String(responseFd))).toEqual({ requestFd, responseFd });
			expect(startInheritedChannel(requestFd, responseFd, () => process.cwd())).toBe(true);

			const output: Buffer[] = [];
			child.stdout!.on("data", (chunk: Buffer) => output.push(chunk));
			const exit = new Promise<number | null>((resolve, reject) => {
				child.once("error", reject);
				child.once("exit", (code) => resolve(code));
			});
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const code = await Promise.race([
				exit,
				new Promise<never>((_, reject) => { timeout = setTimeout(() => { child.kill(); reject(new Error("inherited descriptor test timed out")); }, 5000); }),
			]);
			if (timeout) clearTimeout(timeout);
			expect(code).toBe(0);
			expect(JSON.parse(Buffer.concat(output).toString("utf8"))).toMatchObject({
				v: 1, id: "child-pair", ok: true, result: { area: "subagents", data: { agents: expect.any(Array) } },
			});
		} finally {
			// The channel is process-wide state: release it so later tests bind
			// their own descriptor pair instead of inheriting this one.
			const registry = (globalThis as { [key: symbol]: { channel?: { input: fs.ReadStream } } | undefined })[Symbol.for("agentkit.inspection")];
			registry?.channel?.input.emit("error", new Error("test reset"));
			for (const fd of [requestFd, responseFd]) {
				try { fs.closeSync(fd); } catch { /* already closed by the runtime */ }
			}
			if (child.exitCode === null) child.kill();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("runs the full request/response cycle over real kernel fifo descriptors", { skip: !hasMkfifo }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inspection-fifo-"));
		const requestPath = path.join(dir, "request.fifo");
		const responsePath = path.join(dir, "response.fifo");
		expect(spawnSync("mkfifo", [requestPath, responsePath], { stdio: "ignore" }).status).toBe(0);
		const childScriptPath = path.join(dir, "fifo-child.cjs");
		fs.writeFileSync(childScriptPath, fifoChildScript);
		const child = spawn(process.execPath, [childScriptPath, requestPath, responsePath], { stdio: ["ignore", "pipe", "inherit"] });
		// The blocking parent-side opens complete the fifo handshake with the
		// child: the request open parks until the child's writer appears and
		// the response open parks until the child's reader appears. Both fds
		// stay blocking for their whole lifetime, so no read can return EAGAIN
		// on any runtime.
		const requestFd = fs.openSync(requestPath, fs.constants.O_RDONLY);
		const responseFd = fs.openSync(responsePath, fs.constants.O_WRONLY);
		try {
			expect(validateInheritedFdPair(String(requestFd), String(responseFd))).toEqual({ requestFd, responseFd });
			expect(startInheritedChannel(requestFd, responseFd, () => process.cwd())).toBe(true);
			const output: Buffer[] = [];
			child.stdout!.on("data", (chunk: Buffer) => output.push(chunk));
			const exit = new Promise<number | null>((resolve, reject) => {
				child.once("error", reject);
				child.once("exit", (code) => resolve(code));
			});
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const code = await Promise.race([
				exit,
				new Promise<never>((_, reject) => { timeout = setTimeout(() => { child.kill(); reject(new Error("fifo descriptor test timed out")); }, 5000); }),
			]);
			if (timeout) clearTimeout(timeout);
			expect(code).toBe(0);
			expect(JSON.parse(Buffer.concat(output).toString("utf8"))).toEqual({
				v: 1, id: "fifo-pair", ok: true, result: { v: 1, area: "subagents", data: { agents: [] } },
			});
		} finally {
			// Under bun, stream destroy() closes the descriptor despite
			// autoClose:false (the same defect as the spawn-stdio wrapping
			// skipped above); under Node the descriptors survive destroy and
			// must be closed here.
			for (const fd of [requestFd, responseFd]) {
				try { fs.closeSync(fd); } catch { /* already closed by the runtime */ }
			}
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("frames are limited including newline and preserve UTF-8 across byte chunks", () => {
		const payload = Buffer.from('{"id":"здравствуйте 🐈"}\n');
		let buffer = Buffer.alloc(0);
		let frames: Buffer[] = [];
		for (const byte of payload) {
			const parsed = frameJsonLines(buffer, Buffer.from([byte]));
			buffer = parsed.remainder;
			frames = frames.concat(parsed.lines);
			expect(parsed.oversized).toBe(false);
		}
		expect(frames).toHaveLength(1);
		expect(frames[0].toString("utf8")).toBe('{"id":"здравствуйте 🐈"}');
		// The bound includes the newline: 65535 payload bytes + \n is the
		// largest accepted frame; one more payload byte tips it oversized.
		const largestAccepted = frameJsonLines(Buffer.alloc(0), Buffer.concat([Buffer.alloc(64 * 1024 - 1, 0x61), Buffer.from("\n")]));
		expect(largestAccepted.oversized).toBe(false);
		expect(largestAccepted.lines).toHaveLength(1);
		expect(largestAccepted.lines[0].length).toBe(64 * 1024 - 1);
		const smallestRejected = frameJsonLines(Buffer.alloc(0), Buffer.concat([Buffer.alloc(64 * 1024, 0x61), Buffer.from("\n")]));
		expect(smallestRejected.oversized).toBe(true);
		expect(smallestRejected.lines).toHaveLength(0);
	});

	test("drain, error and close races remove the losing listeners on every cycle", async () => {
		const output = new EventEmitter() as NodeJS.WritableStream & EventEmitter;
		for (let i = 0; i < 5; i++) {
			const waiting = waitForDrain(output);
			output.emit("drain");
			await waiting;
			expect(output.listenerCount("drain")).toBe(0);
			expect(output.listenerCount("error")).toBe(0);
			expect(output.listenerCount("close")).toBe(0);
		}
		const waiting = waitForDrain(output);
		output.emit("error", new Error("closed"));
		await expect(waiting).rejects.toThrow("closed");
		expect(output.listenerCount("drain")).toBe(0);
		expect(output.listenerCount("error")).toBe(0);
		expect(output.listenerCount("close")).toBe(0);
		const closing = waitForDrain(output);
		output.emit("close");
		await expect(closing).rejects.toThrow("output closed before drain");
		expect(output.listenerCount("drain")).toBe(0);
		expect(output.listenerCount("error")).toBe(0);
		expect(output.listenerCount("close")).toBe(0);
	});

	// The cross-reimport registry is keyed on globalThis, so this exercises
	// the same object a re-evaluated extension factory would find after /reload
	// or a session-cwd change.
	test("registers one singleton channel and stop clears the registry", { skip: !hasMkfifo }, () => {
		const registry = (globalThis as { [key: symbol]: { channel?: { input: fs.ReadStream }; cwd?: string } | undefined })[Symbol.for("agentkit.inspection")];
		// Absorb any channel an earlier test in this file left registered.
		const leftover = registry?.channel;
		if (leftover) (leftover.input as unknown as EventEmitter).emit("error", new Error("test reset"));
		expect(registry?.channel).toBeUndefined();

		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inspection-singleton-"));
		const requestPath = path.join(dir, "request.fifo");
		const responsePath = path.join(dir, "response.fifo");
		expect(spawnSync("mkfifo", [requestPath, responsePath], { stdio: "ignore" }).status).toBe(0);
		const requestFd = fs.openSync(requestPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
		// A parent-held writer keeps the channel's request reader from seeing
		// EOF; nothing is ever written through it.
		const holdOpenFd = fs.openSync(requestPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
		const responseFd = fs.openSync(responsePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
		const secondRequestFd = fs.openSync(requestPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
		try {
			expect(startInheritedChannel(requestFd, responseFd, () => process.cwd())).toBe(true);
			const channel = registry?.channel;
			expect(channel).toBeDefined();
			// A repeated call with another fully valid pair is absorbed: true,
			// and the original channel object stays registered untouched.
			expect(startInheritedChannel(secondRequestFd, responseFd, () => process.cwd())).toBe(true);
			expect(registry?.channel).toBe(channel);
			// Even a deliberately invalid pair returns true instead of
			// building a competing second channel.
			expect(startInheritedChannel(responseFd, responseFd, () => process.cwd())).toBe(true);
			expect(registry?.channel).toBe(channel);
			// Stopping the channel clears the registry entry: descriptor
			// validation rejects the next call again.
			(channel!.input as unknown as EventEmitter).emit("error", new Error("test stop"));
			expect(registry?.channel).toBeUndefined();
			expect(startInheritedChannel(responseFd, responseFd, () => process.cwd())).toBe(false);
		} finally {
			for (const fd of [requestFd, holdOpenFd, responseFd, secondRequestFd]) {
				try { fs.closeSync(fd); } catch { /* already closed by the runtime */ }
			}
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
