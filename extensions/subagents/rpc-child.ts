/**
 * RpcChildConnection — one child pi process in `--mode rpc`.
 *
 * Owns the process, strict JSONL framing of its stdout, request-independent
 * event forwarding, stderr capture, and exit/error observation. The controller
 * layers agent semantics on top; this module knows nothing about agents.
 *
 * The spawn function is injectable so unit tests can drive the protocol over
 * in-memory streams without real processes.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { JsonlReader } from "./jsonl";

export interface ChildProcessLike {
	stdin: {
		write(chunk: string): boolean;
		end(): void;
		/**
		 * Subscribe to async stream failures. When the child dies while a write
		 * is still buffered, the write reports success and the stream emits
		 * "error" (EPIPE) on a later tick — a handler must exist or the error
		 * escapes as an uncaughtException.
		 */
		on(event: "error", cb: (err: Error) => void): void;
	};
	stdout: { on(event: "data", cb: (chunk: Buffer) => void): void };
	stderr: { on(event: "data", cb: (chunk: Buffer) => void): void };
	on(event: "error", cb: (err: Error) => void): void;
	on(event: "close", cb: (code: number | null, signal: string | null) => void): void;
	kill(signal: string): boolean;
	pid?: number;
}

export type SpawnFn = (
	command: string,
	args: string[],
	opts: { cwd: string; env?: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessLike;

export interface RpcChildOptions {
	command: string;
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	spawnFn?: SpawnFn;
}

export interface ExitInfo {
	code: number | null;
	signal: string | null;
}

export class RpcChildConnection {
	readonly pid?: number;
	private readonly proc: ChildProcessLike;
	private stderrTail = "";
	private stdinBroken = false;
	private exited = false;
	private exitInfo: ExitInfo | null = null;
	private spawnError: Error | null = null;
	private exitWaiters: Array<(info: ExitInfo) => void> = [];

	onLine: (line: string) => void = () => {};
	onStderr: (text: string) => void = () => {};
	onError: (err: Error) => void = () => {};
	onExit: (info: ExitInfo) => void = () => {};

	constructor(private readonly opts: RpcChildOptions) {
		const spawnFn: SpawnFn = opts.spawnFn ?? defaultSpawn;
		this.proc = spawnFn(opts.command, opts.args, {
			cwd: opts.cwd,
			env: opts.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.pid = this.proc.pid;

		const reader = new JsonlReader((line) => {
			if (!line.trim()) return;
			this.onLine(line);
		});
		this.proc.stdout.on("data", (chunk: Buffer) => reader.push(chunk));
		this.proc.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			// Keep a bounded tail for diagnostics; forward for telemetry.
			this.stderrTail = (this.stderrTail + text).slice(-8000);
			this.onStderr(text);
		});
		this.proc.on("error", (err: Error) => {
			this.spawnError = err;
			this.onError(err);
			this.settleExit({ code: -1, signal: null });
		});
		this.proc.on("close", (code, signal) => {
			reader.end();
			this.settleExit({ code, signal });
		});
		// The child's stdin stream has no other owner; an unhandled "error"
		// here would crash the host process (EPIPE after the child died under
		// a pending write). Swallow it into diagnostics, mark the stream
		// broken so send() stops writing. A broken pipe is NOT proof of process
		// exit: keep kill/waitForExit usable until the real close event, so a
		// workspace cannot publish Git facts while its child is still alive.
		this.proc.stdin.on("error", (err: Error) => {
			if (this.stdinBroken) return;
			this.stdinBroken = true;
			this.stderrTail = (this.stderrTail + `\nchild stdin error: ${err.message}`).slice(-8000);
			if (!this.exited) this.onError(new Error(`child stdin error: ${err.message}`));
		});
	}

	/** Send a JSON command line. Returns false when the process is gone. */
	send(cmd: unknown): boolean {
		if (this.exited || this.spawnError || this.stdinBroken) return false;
		try {
			return this.proc.stdin.write(JSON.stringify(cmd) + "\n");
		} catch {
			return false;
		}
	}

	kill(signal: string): boolean {
		if (this.exited) return false;
		try {
			return this.proc.kill(signal);
		} catch {
			return false;
		}
	}

	get exit(): ExitInfo | null {
		return this.exitInfo;
	}

	get failedToSpawn(): Error | null {
		return this.spawnError;
	}

	get stderr(): string {
		return this.stderrTail;
	}

	/** Resolve when the process exits (immediately when already exited). */
	waitForExit(): Promise<ExitInfo> {
		if (this.exitInfo) return Promise.resolve(this.exitInfo);
		return new Promise((resolve) => this.exitWaiters.push(resolve));
	}

	private settleExit(info: ExitInfo): void {
		if (this.exited) return;
		this.exited = true;
		this.exitInfo = info;
		this.onExit(info);
		for (const w of this.exitWaiters.splice(0)) w(info);
	}
}

function defaultSpawn(
	command: string,
	args: string[],
	opts: { cwd: string; env?: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] },
): ChildProcessLike {
	return nodeSpawn(command, args, {
		cwd: opts.cwd,
		env: opts.env,
		stdio: opts.stdio,
	}) as unknown as ChildProcessLike;
}

/**
 * Resolve how to invoke a pi child from inside a running pi extension:
 * prefer the same node runtime + entry script that hosts us, fall back to
 * the `pi` binary on PATH.
 */
export function resolvePiInvocation(): { command: string; args: string[] } {
	const entry = process.argv[1];
	const isBunVirtual = entry?.startsWith("/$bunfs/root/");
	if (entry && !isBunVirtual && entry.endsWith(".js")) {
		return { command: process.execPath, args: [entry] };
	}
	const execName = entry ? entry.split("/").pop() ?? "" : "";
	if (execName === "cli.js" || execName === "pi.js") {
		return { command: process.execPath, args: [entry] };
	}
	return { command: "pi", args: [] };
}
