import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FakeRpcProcess } from "./fake-rpc";
import { RpcChildConnection, type ExitInfo } from "./rpc-child";

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("RpcChildConnection stdin EPIPE handling (F001)", () => {
	test("SIGKILLed real child: async stdin EPIPE never escapes; settles once; send() goes false", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-child-test-"));
		try {
			const conn = new RpcChildConnection({
				command: process.execPath,
				args: ["-e", "setInterval(() => {}, 1000)"],
				cwd,
			});
			const exits: ExitInfo[] = [];
			conn.onExit = (info) => exits.push(info);

			// Let the child come up, prove the pipe works while it is alive.
			await tick(150);
			expect(conn.pid).toBeNumber();
			expect(conn.send({ type: "ping" })).toBe(true);

			// Buffer a large write (its flush lands after the pipe read end
			// closes) and kill the child: this is the production EPIPE shape —
			// write() succeeds into the stream buffer, then the stream emits
			// EPIPE asynchronously. Without a stdin "error" handler that error
			// escapes as an uncaughtException and kills the test runner.
			conn.send({ type: "spam", blob: "x".repeat(1024 * 1024) });
			conn.kill("SIGKILL");

			// Keep writing while the async error surfaces on a later tick.
			const deadline = Date.now() + 2000;
			while (Date.now() < deadline) {
				conn.send({ type: "spam" }); // must never throw
				if (exits.length > 0 && !conn.send({ type: "spam" })) break;
				await tick(10);
			}
			// A few more sends after settlement: still no throw, still false.
			for (let i = 0; i < 5; i++) {
				expect(conn.send({ type: "spam" })).toBe(false);
				await tick(10);
			}

			const info = await conn.waitForExit();
			expect(exits).toHaveLength(1);
			expect(exits[0]).toBe(info);
			expect(conn.exit).not.toBeNull();
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("fake stdin error: settles exactly once with code -1; send() returns false afterwards", () => {
		const proc = new FakeRpcProcess({ command: "fake-pi", args: [], cwd: "." });
		const conn = new RpcChildConnection({
			command: "fake-pi",
			args: [],
			cwd: ".",
			spawnFn: () => proc,
		});
		const exits: ExitInfo[] = [];
		conn.onExit = (info) => exits.push(info);

		expect(conn.send({ type: "prompt" })).toBe(true);
		proc.emitStdinError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

		expect(exits).toEqual([{ code: -1, signal: null }]);
		expect(conn.exit).toEqual({ code: -1, signal: null });
		expect(conn.stderr).toContain("child stdin error: write EPIPE");
		expect(conn.send({ type: "prompt" })).toBe(false);

		// The later close must not double-settle or overwrite the exit info.
		proc.close(143, null);
		expect(exits).toHaveLength(1);
		expect(conn.exit).toEqual({ code: -1, signal: null });
	});

	test("close before a stdin error keeps the real exit info (idempotent settle)", () => {
		const proc = new FakeRpcProcess({ command: "fake-pi", args: [], cwd: "." });
		const conn = new RpcChildConnection({
			command: "fake-pi",
			args: [],
			cwd: ".",
			spawnFn: () => proc,
		});
		const exits: ExitInfo[] = [];
		conn.onExit = (info) => exits.push(info);

		proc.close(0, null);
		proc.emitStdinError(new Error("write EPIPE"));

		expect(exits).toEqual([{ code: 0, signal: null }]);
		expect(conn.send({})).toBe(false);
	});
});
