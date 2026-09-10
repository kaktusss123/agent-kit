/**
 * Scripted fake child process for controller tests: an in-memory pi RPC
 * endpoint the test drives directly (write lines to its "stdout", read
 * commands from its "stdin").
 */
import { EventEmitter } from "node:events";
import { JsonlReader } from "./jsonl";
import type { ChildProcessLike, SpawnFn } from "./rpc-child";

export type SpawnSpec = { command: string; args: string[]; cwd: string };

type StdioLike = {
	on(event: "data", cb: (chunk: Buffer) => void): unknown;
};

export class FakeRpcProcess implements ChildProcessLike {
	readonly stdin = {
		write: (chunk: string): boolean => {
			this.reader.push(chunk);
			return true;
		},
		end(): void {},
	};
	readonly stdout: StdioLike;
	readonly stderr: StdioLike;
	pid = Math.floor(Math.random() * 100000);

	readonly commands: Array<Record<string, unknown>> = [];
	signalsReceived: string[] = [];
	exitCode: number | null = null;
	exitSignal: string | null = null;
	closed = false;

	/** When true, SIGTERM is ignored (SIGKILL escalation testing). */
	ignoreSigterm = false;

	private readonly events = new EventEmitter();
	private reader!: JsonlReader;

	constructor(public readonly spec: SpawnSpec) {
		this.reader = new JsonlReader((line) => {
			if (!line.trim()) return;
			const cmd = JSON.parse(line) as Record<string, unknown>;
			this.commands.push(cmd);
			this.events.emit("command", cmd);
		});
		this.stdout = {
			on: (_event, cb) => {
				this.events.on("stdout", cb);
				return this;
			},
		};
		this.stderr = {
			on: (_event, cb) => {
				this.events.on("stderr", cb);
				return this;
			},
		};
	}

	writeToStdout(obj: unknown): void {
		if (this.closed) throw new Error("fake process already closed");
		this.events.emit("stdout", Buffer.from(JSON.stringify(obj) + "\n", "utf8"));
	}

	writeToStderr(text: string): void {
		this.events.emit("stderr", Buffer.from(text, "utf8"));
	}

	on(event: "error", cb: (err: Error) => void): void;
	on(event: "close", cb: (code: number | null, signal: string | null) => void): void;
	on(event: string, cb: (...args: unknown[]) => void): void {
		this.events.on(event, cb);
	}

	kill(signal: string): boolean {
		if (this.closed) return false;
		this.signalsReceived.push(signal);
		if (signal === "SIGKILL" || (signal === "SIGTERM" && !this.ignoreSigterm)) {
			this.close(signal === "SIGKILL" ? null : 143, signal === "SIGKILL" ? "SIGKILL" : null);
		}
		return true;
	}

	close(code: number | null, signal: string | null): void {
		if (this.closed) return;
		this.closed = true;
		this.exitCode = code;
		this.exitSignal = signal;
		this.events.emit("close", code, signal);
	}

	/** Command helpers for tests. */
	lastCommand(type: string): Record<string, unknown> | undefined {
		return [...this.commands].reverse().find((c) => c.type === type);
	}
}

export interface FakeHarness {
	spawned: FakeRpcProcess[];
	spawnFn: SpawnFn;
	onSpawn: (handler: (proc: FakeRpcProcess, spec: SpawnSpec) => void) => void;
}

export function createFakeSpawnFactory(): FakeHarness {
	const spawned: FakeRpcProcess[] = [];
	let handler: ((proc: FakeRpcProcess, spec: SpawnSpec) => void) | null = null;
	const spawnFn: SpawnFn = (command, args, opts) => {
		const proc = new FakeRpcProcess({ command, args, cwd: opts.cwd });
		spawned.push(proc);
		// Mirror pi RPC behavior: respond async so promise chains settle
		// naturally.
		queueMicrotask(() => handler?.(proc, proc.spec));
		return proc;
	};
	return {
		spawned,
		spawnFn,
		onSpawn: (h) => {
			handler = h;
		},
	};
}

/** Auto-accept the initial prompt like a real pi RPC child. */
export function autoAcceptPrompt(proc: FakeRpcProcess, requestId = "spawn-prompt"): void {
	const timer = setInterval(() => {
		const prompt = proc.commands.find((c) => c.type === "prompt" && c.id === requestId);
		if (prompt) {
			clearInterval(timer);
			proc.writeToStdout({ id: requestId, type: "response", command: "prompt", success: true });
		}
	}, 1);
}

export function settleChild(proc: FakeRpcProcess, finalText: string): void {
	proc.writeToStdout({ type: "agent_settled" });
	// Respond to the settle-time fetches as they arrive, consuming each so a
	// second settle round works too.
	const timer = setInterval(() => {
		const stateCmd = proc.commands.find((c) => c.type === "get_state");
		const statsCmd = proc.commands.find((c) => c.type === "get_session_stats");
		const textCmd = proc.commands.find((c) => c.type === "get_last_assistant_text");
		if (stateCmd) {
			proc.writeToStdout({
				id: stateCmd.id,
				type: "response",
				command: "get_state",
				success: true,
				data: { sessionFile: "/tmp/fake-session.jsonl", sessionId: "fake-session" },
			});
			proc.commands.splice(proc.commands.indexOf(stateCmd), 1);
		}
		if (statsCmd) {
			proc.writeToStdout({
				id: statsCmd.id,
				type: "response",
				command: "get_session_stats",
				success: true,
				data: { tokens: { input: 10, output: 5, total: 15 }, cost: 0.01 },
			});
			proc.commands.splice(proc.commands.indexOf(statsCmd), 1);
		}
		if (textCmd) {
			proc.writeToStdout({
				id: textCmd.id,
				type: "response",
				command: "get_last_assistant_text",
				success: true,
				data: { text: finalText },
			});
			clearInterval(timer);
		}
	}, 1);
}
