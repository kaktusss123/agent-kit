import { afterEach, describe, expect, test } from "bun:test";
import agentEventsExtension from "./index";

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

	test("ui prompts map to attention_required/attention_resolved", () => {
		const h = harness();
		try {
			h.pi.emit({ type: "session_start", reason: "startup" }, tuiContext());
			h.pi.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "Allow rm?" }, {});
			h.pi.emit({ type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm", title: "Allow rm?" }, {});

			expect(events(h.written)[1]).toMatchObject({ event: "question_asked", summary: "Allow rm?" });
			expect(events(h.written)[2]).toMatchObject({ event: "permission_replied" });
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
});
