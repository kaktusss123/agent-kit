/**
 * Scripted fake child process for controller tests: an in-memory pi RPC
 * endpoint the test drives directly (write lines to its "stdout", read
 * commands from its "stdin").
 */
import { EventEmitter } from "node:events";
import { JsonlReader } from "./jsonl.ts";
import type { ChildProcessLike, SpawnFn } from "./rpc-child.ts";

export type SpawnSpec = { command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv };

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
		on: (event: "error", cb: (err: Error) => void): void => {
			this.events.on("stdin-error", cb);
		},
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

	/**
	 * When true, even SIGKILL produces no `close` event: simulates a
	 * grandchild that inherited stdio and holds the pipes open after the
	 * child's death. cancel()/retire() must still return.
	 */
	neverClose = false;

	/**
	 * Respond success to any `prompt` command carrying a `streamingBehavior`
	 * (steer/follow_up dispatches), like a real pi preflight.
	 */
	autoRespondPrompts = true;

	private readonly events = new EventEmitter();
	private reader!: JsonlReader;
	readonly spec: SpawnSpec;

	constructor(spec: SpawnSpec) {
		this.spec = spec;
		this.reader = new JsonlReader((line) => {
			if (!line.trim()) return;
			const cmd = JSON.parse(line) as Record<string, unknown>;
			this.commands.push(cmd);
			this.events.emit("command", cmd);
			if (
				this.autoRespondPrompts &&
				(cmd.type === "steer" || (cmd.type === "prompt" &&
				typeof cmd.streamingBehavior === "string"))
			) {
				const response = {
					id: cmd.id,
					type: "response",
					command: cmd.type,
					success: true,
				};
				queueMicrotask(() => {
					if (!this.closed) this.writeToStdout(response);
				});
			}
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

	/** Test hook: the child's stdin stream dies asynchronously (e.g. EPIPE). */
	emitStdinError(err: Error): void {
		this.events.emit("stdin-error", err);
	}

	on(event: "error", cb: (err: Error) => void): void;
	on(event: "close", cb: (code: number | null, signal: string | null) => void): void;
	on(event: string, cb: (...args: unknown[]) => void): void {
		this.events.on(event, cb);
	}

	kill(signal: string): boolean {
		if (this.closed) return false;
		this.signalsReceived.push(signal);
		if (this.neverClose) return true;
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
		const proc = new FakeRpcProcess({ command, args, cwd: opts.cwd, env: opts.env });
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

/** Auto-accept the initial prompt like a real pi RPC child and open the run. */
export function autoAcceptPrompt(proc: FakeRpcProcess, requestId = "spawn-prompt"): void {
	const timer = setInterval(() => {
		if (proc.closed) {
			clearInterval(timer);
			return;
		}
		const prompt = proc.commands.find((c) => c.type === "prompt" && c.id === requestId);
		if (prompt) {
			clearInterval(timer);
			try {
				proc.writeToStdout({ id: requestId, type: "response", command: "prompt", success: true });
				proc.writeToStdout({ type: "agent_start" });
			} catch {
				// process died between ticks — nothing to accept
			}
		}
	}, 1);
}

/** Open a new low-level run, like pi's agent_start. */
export function startRun(proc: FakeRpcProcess): void {
	proc.writeToStdout({ type: "agent_start" });
}

/**
 * Emit the readiness report notify (protocol per readiness.ts): one
 * fire-and-forget notify carrying the child's observed tool set; the
 * controller validates it against its own per-spawn contract.
 */
export function confirmReadiness(
	proc: FakeRpcProcess,
	opts?: { tools?: string[]; protocol?: string },
): void {
	proc.writeToStdout({
		type: "extension_ui_request",
		id: `ui-rd-${Math.random().toString(36).slice(2, 8)}`,
		method: "notify",
		notifyType: "info",
		message: JSON.stringify({
			protocol: opts?.protocol ?? "pi-subagents-readiness",
			tools: opts?.tools ?? [],
		}),
	});
}

/** Close the current run with a final assistant text. */
export function settleRun(proc: FakeRpcProcess, finalText: string): void {
	if (proc.closed) return;
	proc.writeToStdout({ type: "agent_settled" });
	// Respond to the settle-time fetches as they arrive, consuming each so a
	// second settle round works too. Tolerates the process dying mid-round.
	const timer = setInterval(() => {
		if (proc.closed) {
			clearInterval(timer);
			return;
		}
		// Drain ALL outstanding state/stats fetches (an early identity fetch may
		// coexist with the settle-time one), then answer the text fetch last.
		let stateCmd = proc.commands.find((c) => c.type === "get_state");
		while (stateCmd) {
			try {
				proc.writeToStdout({
					id: stateCmd.id,
					type: "response",
					command: "get_state",
					success: true,
					data: { sessionFile: "/tmp/fake-session.jsonl", sessionId: "fake-session" },
				});
				proc.commands.splice(proc.commands.indexOf(stateCmd), 1);
			} catch {
				clearInterval(timer);
				return;
			}
			stateCmd = proc.commands.find((c) => c.type === "get_state");
		}
		let statsCmd = proc.commands.find((c) => c.type === "get_session_stats");
		while (statsCmd) {
			try {
				proc.writeToStdout({
					id: statsCmd.id,
					type: "response",
					command: "get_session_stats",
					success: true,
					data: { tokens: { input: 10, output: 5, total: 15 }, cost: 0.01 },
				});
				proc.commands.splice(proc.commands.indexOf(statsCmd), 1);
			} catch {
				clearInterval(timer);
				return;
			}
			statsCmd = proc.commands.find((c) => c.type === "get_session_stats");
		}
		const textCmd = proc.commands.find((c) => c.type === "get_last_assistant_text");
		if (textCmd) {
			try {
				proc.writeToStdout({
					id: textCmd.id,
					type: "response",
					command: "get_last_assistant_text",
					success: true,
					data: { text: finalText },
				});
				clearInterval(timer);
			} catch {
				clearInterval(timer);
			}
		}
	}, 1);
}
