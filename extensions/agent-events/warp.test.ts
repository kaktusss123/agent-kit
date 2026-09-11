import { describe, expect, test } from "bun:test";
import { shouldCreateTerminalSink, type AgentEvent } from "./events";
import { toWarpEvent, WarpCliAgentSink } from "./warp-sink";
import {
	buildWarpFrame,
	finalizeWarpFrame,
	isInsideTmux,
	isWarpProtocolAdvertised,
	wrapTmuxPassthrough,
} from "./warp";

const ENVELOPE = {
	sessionId: "session-123",
	cwd: "/some/dir",
	project: "dir",
	pluginVersion: "0.1.0",
};

describe("isWarpProtocolAdvertised (capability gate)", () => {
	test("accepts version 1", () => {
		expect(isWarpProtocolAdvertised({ WARP_CLI_AGENT_PROTOCOL_VERSION: "1" })).toBe(true);
	});

	test("accepts newer advertised versions", () => {
		expect(isWarpProtocolAdvertised({ WARP_CLI_AGENT_PROTOCOL_VERSION: "2" })).toBe(true);
	});

	test("rejects missing, empty, and garbage values", () => {
		expect(isWarpProtocolAdvertised({})).toBe(false);
		expect(isWarpProtocolAdvertised({ WARP_CLI_AGENT_PROTOCOL_VERSION: "" })).toBe(false);
		expect(isWarpProtocolAdvertised({ WARP_CLI_AGENT_PROTOCOL_VERSION: "not-a-number" })).toBe(false);
	});

	test("rejects version 0", () => {
		expect(isWarpProtocolAdvertised({ WARP_CLI_AGENT_PROTOCOL_VERSION: "0" })).toBe(false);
	});
});

describe("shouldCreateTerminalSink (top-level interactive gate)", () => {
	test("allows interactive TUI with a TTY stdout", () => {
		expect(shouldCreateTerminalSink("tui", true)).toBe(true);
	});

	test("blocks every non-TUI mode even with a TTY", () => {
		expect(shouldCreateTerminalSink("print", true)).toBe(false);
		expect(shouldCreateTerminalSink("json", true)).toBe(false);
		expect(shouldCreateTerminalSink("rpc", true)).toBe(false);
	});

	test("blocks TUI mode without a TTY stdout (piped/subagent processes)", () => {
		expect(shouldCreateTerminalSink("tui", false)).toBe(false);
		expect(shouldCreateTerminalSink("tui", undefined)).toBe(false);
	});
});

describe("Warp wire format", () => {
	test("builds the exact OSC 777 frame", () => {
		const frame = buildWarpFrame({ event: "stop", query: "hi" }, ENVELOPE);
		expect(frame).toBe(
			`\x1b]777;notify;warp://cli-agent;{"event":"stop","query":"hi","v":1,"agent":"pi",` +
				`"session_id":"session-123","cwd":"/some/dir","project":"dir","plugin_version":"0.1.0"}\x07`,
		);
	});

	test("omits undefined payload fields", () => {
		const frame = buildWarpFrame({ event: "permission_replied" }, ENVELOPE);
		expect(frame).toBe(
			`\x1b]777;notify;warp://cli-agent;{"event":"permission_replied","v":1,"agent":"pi",` +
				`"session_id":"session-123","cwd":"/some/dir","project":"dir","plugin_version":"0.1.0"}\x07`,
		);
	});

	test("envelope wins over payload key collisions", () => {
		const frame = buildWarpFrame(
			{ event: "prompt_submit", query: "x" } as never,
			ENVELOPE,
		);
		expect(frame).toContain(`"agent":"pi"`);
		expect(frame).not.toContain(`"agent":"evil"`);
	});

	test("escapes control characters inside JSON via JSON.stringify", () => {
		const frame = buildWarpFrame({ event: "stop", response: "a\x1bb" }, ENVELOPE);
		expect(frame).toContain("\\u001b");
		expect(frame.endsWith("\x07")).toBe(true);
	});

	test("direct terminal frames are never double-belled", () => {
		const frame = buildWarpFrame({ event: "stop" }, ENVELOPE);
		expect(finalizeWarpFrame(frame, { tmux: false, attention: true })).toBe(frame);
		expect(frame.endsWith("\x07\x07")).toBe(false);
	});
});

describe("tmux passthrough", () => {
	test("isInsideTmux detects TMUX env", () => {
		expect(isInsideTmux({ TMUX: "/tmp/sock,1,0" })).toBe(true);
		expect(isInsideTmux({})).toBe(false);
	});

	test("wraps with DCS and doubles ESC bytes", () => {
		const frame = buildWarpFrame({ event: "stop" }, ENVELOPE);
		const wrapped = wrapTmuxPassthrough(frame);
		expect(wrapped.startsWith("\x1bPtmux;")).toBe(true);
		expect(wrapped.endsWith("\x1b\\")).toBe(true);
		// Only the trailing terminator BEL remains a single ESC-free BEL; every
		// ESC in the original frame is doubled.
		const inner = wrapped.slice("\x1bPtmux;".length, -"\x1b\\".length);
		expect(inner).toBe(frame.replaceAll("\x1b", "\x1b\x1b"));
	});

	test("attention events get one outer BEL after the DCS ST", () => {
		const frame = buildWarpFrame({ event: "stop" }, ENVELOPE);
		const wrapped = finalizeWarpFrame(frame, { tmux: true, attention: true });
		expect(wrapped.endsWith("\x1b\\\x07")).toBe(true);
		expect(wrapped.endsWith("\x07\x07")).toBe(false);
	});

	test("non-attention events end with the DCS ST only", () => {
		const frame = buildWarpFrame({ event: "prompt_submit" }, ENVELOPE);
		const wrapped = finalizeWarpFrame(frame, { tmux: true, attention: false });
		expect(wrapped.endsWith("\x1b\\")).toBe(true);
		expect(wrapped.endsWith("\x1b\\\x07")).toBe(false);
	});
});

describe("semantic -> Warp event mapping", () => {
	test("session_started maps to session_start without leaking envelope fields", () => {
		const { payload, attention } = toWarpEvent({ type: "session_started", sessionId: "s" });
		expect(payload).toEqual({ event: "session_start" });
		expect(attention).toBe(false);
	});

	test("run_started maps to prompt_submit with the query", () => {
		const { payload, attention } = toWarpEvent({ type: "run_started", query: "fix tests" });
		expect(payload).toEqual({ event: "prompt_submit", query: "fix tests" });
		expect(attention).toBe(false);
	});

	test("run_completed maps to stop (attention)", () => {
		const { payload, attention } = toWarpEvent({ type: "run_completed", query: "q", response: "r" });
		expect(payload).toEqual({ event: "stop", query: "q", response: "r" });
		expect(attention).toBe(true);
	});

	test("run_failed maps to stop_failure with error_type error", () => {
		const { payload } = toWarpEvent({ type: "run_failed", query: "q", error: "boom" });
		expect(payload).toEqual({ event: "stop_failure", query: "q", response: undefined, error_type: "error" });
	});

	test("run_aborted maps to stop_failure with error_type cancelled", () => {
		const { payload, attention } = toWarpEvent({ type: "run_aborted", query: "q" });
		expect(payload).toEqual({ event: "stop_failure", query: "q", error_type: "cancelled" });
		expect(attention).toBe(true);
	});

	test("attention_required maps to question_asked with a title or kind fallback", () => {
		expect(toWarpEvent({ type: "attention_required", kind: "confirm", title: "Allow rm?" })).toEqual({
			payload: { event: "question_asked", summary: "Allow rm?" },
			attention: true,
		});
		expect(toWarpEvent({ type: "attention_required", kind: "input" })).toEqual({
			payload: { event: "question_asked", summary: "Waiting for your input" },
			attention: true,
		});
	});

	test("attention_resolved maps to permission_replied", () => {
		const { payload, attention } = toWarpEvent({ type: "attention_resolved", kind: "confirm" });
		expect(payload).toEqual({ event: "permission_replied" });
		expect(attention).toBe(false);
	});
});

describe("WarpCliAgentSink", () => {
	function capture() {
		const written: string[] = [];
		return {
			written,
			write: (data: string) => {
				written.push(data);
			},
		};
	}

	const BASE = {
		sessionId: "s1",
		getCwd: () => "/tmp/proj",
		pluginVersion: "0.1.0",
	};

	test("writes frames to the injected writer", () => {
		const { written, write } = capture();
		const sink = new WarpCliAgentSink({ ...BASE, write, env: {} });
		sink.emit({ type: "run_started", query: "hi" });
		expect(written).toHaveLength(1);
		expect(written[0]).toContain(`"event":"prompt_submit"`);
		expect(written[0]!.startsWith("\x1b]777;notify;warp://cli-agent;")).toBe(true);
		expect(written[0]!.endsWith("\x07")).toBe(true);
	});

	test("re-reads cwd per emit", () => {
		const { written, write } = capture();
		let cwd = "/one";
		const sink = new WarpCliAgentSink({ ...BASE, getCwd: () => cwd, write, env: {} });
		sink.emit({ type: "run_started" });
		cwd = "/two";
		sink.emit({ type: "run_started" });
		expect(written[0]).toContain('"cwd":"/one","project":"one"');
		expect(written[1]).toContain('"cwd":"/two","project":"two"');
	});

	test("wraps frames under tmux", () => {
		const { written, write } = capture();
		const sink = new WarpCliAgentSink({ ...BASE, write, env: { TMUX: "/tmp/sock,1,0" } });
		sink.emit({ type: "run_started" });
		expect(written[0]!.startsWith("\x1bPtmux;")).toBe(true);
		expect(written[0]!.endsWith("\x1b\\")).toBe(true);
	});

	test("appends the outer bell for attention events under tmux only", () => {
		const tmuxWritten: string[] = [];
		const bareWritten: string[] = [];
		new WarpCliAgentSink({ ...BASE, write: (d) => tmuxWritten.push(d), env: { TMUX: "1" } }).emit({
			type: "run_completed",
		});
		new WarpCliAgentSink({ ...BASE, write: (d) => bareWritten.push(d), env: {} }).emit({
			type: "run_completed",
		});
		expect(tmuxWritten[0]!.endsWith("\x1b\\\x07")).toBe(true);
		expect(bareWritten[0]!.endsWith("\x07")).toBe(true);
		expect(bareWritten[0]!.endsWith("\x07\x07")).toBe(false);
	});

	test("swallows writer failures", () => {
		const sink = new WarpCliAgentSink({
			...BASE,
			write: () => {
				throw new Error("EIO");
			},
			env: {},
		});
		expect(() => sink.emit({ type: "run_started" } as AgentEvent)).not.toThrow();
	});
});
