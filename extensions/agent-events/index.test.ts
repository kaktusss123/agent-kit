import { afterEach, describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import agentEventsExtension from "./index.ts";

type Handler = (event: any, ctx: any) => any;

class FakePi {
	readonly handlers = new Map<string, Handler[]>();
	on(event: string, handler: Handler): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}
	emit(event: any, ctx: any = {}): void {
		for (const handler of this.handlers.get(event.type) ?? []) handler(event, ctx);
	}
}

function tuiContext(sessionId = "s1") {
	return {
		mode: "tui",
		sessionManager: {
			getSessionId: () => sessionId,
			getCwd: () => "/tmp/proj",
		},
	};
}

function assistant(overrides: Partial<{ stopReason: string; errorMessage: string; text: string }> = {}) {
	return {
		role: "assistant",
		content: overrides.text ? [{ type: "text", text: overrides.text }] : [],
		stopReason: overrides.stopReason ?? "stop",
		errorMessage: overrides.errorMessage,
	};
}

/** Harness: installs the extension, spies on stdout, fakes env + TTY state. */
function harness(options: { isTTY?: boolean; warpEnv?: boolean } = {}) {
	const pi = new FakePi();
	const written: string[] = [];
	const realWrite = process.stdout.write.bind(process.stdout);
	const realIsTTY = (process.stdout as any).isTTY;
	const realWarpEnv = process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;

	(process.stdout as any).write = (data: string) => {
		written.push(data);
		return true;
	};
	(process.stdout as any).isTTY = options.isTTY ?? true;
	if (options.warpEnv ?? true) process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "1";
	else delete process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;

	agentEventsExtension(pi as never);

	return {
		pi,
		written,
		restore() {
			(process.stdout as any).write = realWrite;
			(process.stdout as any).isTTY = realIsTTY;
			if (realWarpEnv === undefined) delete process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;
			else process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = realWarpEnv;
		},
	};
}

function events(written: string[]) {
	return written.map((frame) => JSON.parse(frame.slice("\x1b]777;notify;warp://cli-agent;".length, -1)));
}

afterEach(() => {});

describe("agent-events extension lifecycle", () => {
	test("full run: session -> run -> settled completion", () => {
		const h = harness();
		try {
			h.pi.emit({ type: "session_start", reason: "startup" }, tuiContext());
			h.pi.emit({ type: "before_agent_start", prompt: "fix the bug" }, {});
			h.pi.emit({ type: "agent_start" }, {});
			h.pi.emit({ type: "agent_end", messages: [assistant({ text: "all done" })] }, {});
			h.pi.emit({ type: "agent_settled" }, {});

			expect(events(h.written).map((e) => e.event)).toEqual([
				"session_start",
				"prompt_submit",
				"stop",
			]);
			expect(events(h.written)[2]).toMatchObject({ query: "fix the bug", response: "all done", agent: "pi" });
		} finally {
			h.restore();
		}
	});

	test("failed run settles as stop_failure with the query", () => {
		const h = harness();
		try {
			h.pi.emit({ type: "session_start", reason: "startup" }, tuiContext());
			h.pi.emit({ type: "before_agent_start", prompt: "doomed task" }, {});
			h.pi.emit({ type: "agent_start" }, {});
			h.pi.emit(
				{ type: "agent_end", messages: [assistant({ stopReason: "error", errorMessage: "rate limited" })] },
				{},
			);
			h.pi.emit({ type: "agent_settled" }, {});

			expect(events(h.written)[2]).toMatchObject({
				event: "stop_failure",
				query: "doomed task",
				response: "rate limited",
				error_type: "error",
			});
		} finally {
			h.restore();
		}
	});

	test("aborted run settles as stop_failure cancelled", () => {
		const h = harness();
		try {
			h.pi.emit({ type: "session_start", reason: "startup" }, tuiContext());
			h.pi.emit({ type: "before_agent_start", prompt: "long task" }, {});
			h.pi.emit({ type: "agent_start" }, {});
			h.pi.emit({ type: "agent_end", messages: [assistant({ stopReason: "aborted" })] }, {});
			h.pi.emit({ type: "agent_settled" }, {});

			expect(events(h.written)[2]).toMatchObject({ event: "stop_failure", error_type: "cancelled" });
		} finally {
			h.restore();
		}
	});

	test("agent_end alone does not finalize; only agent_settled does", () => {
		const h = harness();
		try {
			h.pi.emit({ type: "session_start", reason: "startup" }, tuiContext());
			h.pi.emit({ type: "before_agent_start", prompt: "q" }, {});
			h.pi.emit({ type: "agent_start" }, {});
			h.pi.emit({ type: "agent_end", messages: [assistant({ text: "draft" })] }, {});
			expect(events(h.written).map((e) => e.event)).toEqual(["session_start", "prompt_submit"]);
		} finally {
			h.restore();
		}
	});

	test("ui prompts during a run map to attention_required/attention_resolved", () => {
		const h = harness();
		try {
			h.pi.emit({ type: "session_start", reason: "startup" }, tuiContext());
			h.pi.emit({ type: "before_agent_start", prompt: "q" }, {});
			h.pi.emit({ type: "agent_start" }, {});
			h.pi.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "Allow rm?" }, {});
			h.pi.emit({ type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm", title: "Allow rm?" }, {});

			expect(events(h.written)[1]).toMatchObject({ event: "prompt_submit" });
			expect(events(h.written)[2]).toMatchObject({ event: "question_asked", summary: "Allow rm?" });
			expect(events(h.written)[3]).toMatchObject({ event: "permission_replied" });
		} finally {
			h.restore();
		}
	});

	test("idle ui prompts (no active run) never reach the sink", () => {
		const h = harness();
		try {
			h.pi.emit({ type: "session_start", reason: "startup" }, tuiContext());
			h.pi.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "Pick one" }, {});
			h.pi.emit({ type: "ui_prompt_end", reason: "ui_prompt", kind: "select", title: "Pick one" }, {});
			expect(events(h.written)).toHaveLength(1); // session_start only
		} finally {
			h.restore();
		}
	});

	test("attention resolved after settle does not emit permission_replied", () => {
		const h = harness();
		try {
			h.pi.emit({ type: "session_start", reason: "startup" }, tuiContext());
			h.pi.emit({ type: "before_agent_start", prompt: "q" }, {});
			h.pi.emit({ type: "agent_start" }, {});
			h.pi.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm" }, {});
			h.pi.emit({ type: "agent_end", messages: [assistant({ text: "done" })] }, {});
			h.pi.emit({ type: "agent_settled" }, {});
			h.pi.emit({ type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm" }, {});

			const names = events(h.written).map((e) => e.event);
			expect(names).toEqual(["session_start", "prompt_submit", "question_asked", "stop"]);
		} finally {
			h.restore();
		}
	});

	test("headless mode never creates a terminal sink", () => {
		const h = harness();
		try {
			const ctx = { ...tuiContext(), mode: "print" };
			h.pi.emit({ type: "session_start", reason: "startup" }, ctx);
			h.pi.emit({ type: "before_agent_start", prompt: "q" }, {});
			h.pi.emit({ type: "agent_start" }, {});
			h.pi.emit({ type: "agent_settled" }, {});
			expect(h.written).toEqual([]);
		} finally {
			h.restore();
		}
	});

	test("non-TTY stdout (subagent/piped process) never creates a terminal sink", () => {
		const h = harness({ isTTY: false });
		try {
			h.pi.emit({ type: "session_start", reason: "startup" }, tuiContext());
			h.pi.emit({ type: "agent_start" }, {});
			h.pi.emit({ type: "agent_settled" }, {});
			expect(h.written).toEqual([]);
		} finally {
			h.restore();
		}
	});

	test("missing Warp capability never creates a terminal sink", () => {
		const h = harness({ warpEnv: false });
		try {
			h.pi.emit({ type: "session_start", reason: "startup" }, tuiContext());
			h.pi.emit({ type: "agent_start" }, {});
			h.pi.emit({ type: "agent_settled" }, {});
			expect(h.written).toEqual([]);
		} finally {
			h.restore();
		}
	});

	test("retry continuation (second agent_start) does not restart the logical run", () => {
		const h = harness();
		try {
			h.pi.emit({ type: "session_start", reason: "startup" }, tuiContext());
			h.pi.emit({ type: "before_agent_start", prompt: "q" }, {});
			h.pi.emit({ type: "agent_start" }, {});
			h.pi.emit(
				{ type: "agent_end", messages: [assistant({ stopReason: "error", errorMessage: "overloaded" })] },
				{},
			);
			// Auto-retry continuation re-enters the low-level loop.
			h.pi.emit({ type: "agent_start" }, {});
			h.pi.emit({ type: "agent_end", messages: [assistant({ text: "recovered" })] }, {});
			h.pi.emit({ type: "agent_settled" }, {});

			const names = events(h.written).map((e) => e.event);
			expect(names).toEqual(["session_start", "prompt_submit", "stop"]);
			expect(events(h.written)[2]).toMatchObject({ query: "q", response: "recovered" });
		} finally {
			h.restore();
		}
	});

	test("each new logical run after settle gets its own run_started", () => {
		const h = harness();
		try {
			h.pi.emit({ type: "session_start", reason: "startup" }, tuiContext());
			for (const prompt of ["first", "second"]) {
				h.pi.emit({ type: "before_agent_start", prompt }, {});
				h.pi.emit({ type: "agent_start" }, {});
				h.pi.emit({ type: "agent_end", messages: [assistant({ text: `ok: ${prompt}` })] }, {});
				h.pi.emit({ type: "agent_settled" }, {});
			}
			const names = events(h.written).map((e) => e.event);
			expect(names).toEqual([
				"session_start",
				"prompt_submit",
				"stop",
				"prompt_submit",
				"stop",
			]);
		} finally {
			h.restore();
		}
	});

	test("session rebind creates a fresh sink with the new session id", () => {
		const h = harness();
		try {
			h.pi.emit({ type: "session_start", reason: "startup" }, tuiContext("s1"));
			h.pi.emit({ type: "session_start", reason: "resume" }, tuiContext("s2"));
			expect(events(h.written)[1]).toMatchObject({ event: "session_start", session_id: "s2" });
		} finally {
			h.restore();
		}
	});

	test("session_shutdown detaches the sink", () => {
		const h = harness();
		try {
			h.pi.emit({ type: "session_start", reason: "startup" }, tuiContext());
			h.pi.emit({ type: "session_shutdown", reason: "quit" }, {});
			h.pi.emit({ type: "agent_start" }, {});
			expect(events(h.written)).toHaveLength(1);
		} finally {
			h.restore();
		}
	});

	test("sink write failures never break extension handlers", () => {
		const h = harness();
		try {
			h.pi.emit({ type: "session_start", reason: "startup" }, tuiContext());
			(process.stdout as any).write = () => {
				throw new Error("EIO");
			};
			expect(() => h.pi.emit({ type: "agent_start" }, {})).not.toThrow();
		} finally {
			h.restore();
		}
	});

	test("custom turn (messageType custom, no prompt) still opens a run without throwing", () => {
		const h = harness();
		try {
			h.pi.emit({ type: "session_start", reason: "startup" }, tuiContext());
			// Idle custom turn (e.g. a hidden continue directive): no `prompt` field.
			expect(() =>
				h.pi.emit(
					{ type: "before_agent_start", messageType: "custom", message: { customType: "x", content: "go on" } },
					{},
				),
			).not.toThrow();
			h.pi.emit({ type: "agent_start" }, {});
			h.pi.emit({ type: "agent_end", messages: [assistant({ text: "continued" })] }, {});
			h.pi.emit({ type: "agent_settled" }, {});

			const names = events(h.written).map((e) => e.event);
			expect(names).toEqual(["session_start", "prompt_submit", "stop"]);
			// No user query text exists for a custom turn — the run is still reported.
			expect(events(h.written)[2]).toMatchObject({ response: "continued" });
			expect("query" in events(h.written)[2] && events(h.written)[2].query).toBeFalsy();
		} finally {
			h.restore();
		}
	});

	test("user turn after a custom turn carries its own query", () => {
		const h = harness();
		try {
			h.pi.emit({ type: "session_start", reason: "startup" }, tuiContext());
			h.pi.emit(
				{ type: "before_agent_start", messageType: "custom", message: { customType: "x", content: "go on" } },
				{},
			);
			h.pi.emit({ type: "agent_start" }, {});
			h.pi.emit({ type: "agent_end", messages: [assistant({ text: "continued" })] }, {});
			h.pi.emit({ type: "agent_settled" }, {});
			h.pi.emit({ type: "before_agent_start", messageType: "user", prompt: "fix the bug" }, {});
			h.pi.emit({ type: "agent_start" }, {});
			h.pi.emit({ type: "agent_end", messages: [assistant({ text: "fixed" })] }, {});
			h.pi.emit({ type: "agent_settled" }, {});

			expect(events(h.written).map((e) => e.event)).toEqual([
				"session_start",
				"prompt_submit",
				"stop",
				"prompt_submit",
				"stop",
			]);
			expect(events(h.written)[4]).toMatchObject({ query: "fix the bug", response: "fixed" });
		} finally {
			h.restore();
		}
	});
});
