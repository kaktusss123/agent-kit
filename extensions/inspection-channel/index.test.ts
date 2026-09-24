import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { frameJsonLines, handleInspectionRequest, startInheritedChannel, validateInheritedFd, validateInheritedFdPair, validateRequest, waitForDrain } from "./index";

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
			expect(task).toMatchObject({ v: 1, id: "b", ok: true, result: { v: 1, area: "task" } });
		} finally {
			if (previous === undefined) delete process.env.AGENT_TASK_ROOT;
			else process.env.AGENT_TASK_ROOT = previous;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects malformed, unknown and invalid requests without throwing", async () => {
		expect(await handleInspectionRequest("not-json", deps)).toMatchObject({ ok: false, error: { code: "malformed_json" } });
		expect(await handleInspectionRequest('{"v":2,"id":"x","op":"snapshot","area":"all"}', deps)).toMatchObject({ ok: false, error: { code: "unknown_version" } });
		expect(await handleInspectionRequest('{"v":1,"id":"x","op":"nope","area":"all"}', deps)).toMatchObject({ ok: false, error: { code: "unknown_op" } });
		expect(validateRequest({ v: 1, id: "x", op: "snapshot", area: "nope" })).toMatchObject({ error: { code: "unknown_area" } });
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

	// bun's child_process wraps extra stdio fds in active Sockets that consume
	// the data into their own buffers, and destroying any stream on such an fd
	// closes it despite autoClose:false — the inherited-descriptor path cannot
	// be exercised through spawn stdio under bun; production host is Node 24
	// (real-Pi probes) and the fifo test below keeps real-kernel-fd coverage
	// on every runtime.
	test.skipIf(process.isBun)("accepts and uses a real inherited bidirectional socket pair", async () => {
		const child = spawn(process.execPath, ["-e", `
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
		`], { stdio: ["ignore", "pipe", "inherit", "pipe", "pipe"] });
		const requestFd = (child.stdio[3] as unknown as { _handle: { fd: number } })._handle.fd;
		const responseFd = (child.stdio[4] as unknown as { _handle: { fd: number } })._handle.fd;
		const pair = validateInheritedFdPair(String(requestFd), String(responseFd));
		expect(pair).toEqual({ requestFd, responseFd });
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
	});

	test.skipIf(!hasMkfifo)("runs the full request/response cycle over real kernel fifo descriptors on every runtime", async () => {
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
		const exactPayloadLimit = Buffer.concat([Buffer.alloc(64 * 1024, 0x61), Buffer.from("\n")]);
		expect(frameJsonLines(Buffer.alloc(0), exactPayloadLimit).oversized).toBe(true);
	});

	test("drain and error races remove the losing listener on every cycle", async () => {
		const output = new EventEmitter() as NodeJS.WritableStream & EventEmitter;
		for (let i = 0; i < 5; i++) {
			const waiting = waitForDrain(output);
			output.emit("drain");
			await waiting;
			expect(output.listenerCount("drain")).toBe(0);
			expect(output.listenerCount("error")).toBe(0);
		}
		const waiting = waitForDrain(output);
		output.emit("error", new Error("closed"));
		await expect(waiting).rejects.toThrow("closed");
		expect(output.listenerCount("drain")).toBe(0);
		expect(output.listenerCount("error")).toBe(0);
	});
});
