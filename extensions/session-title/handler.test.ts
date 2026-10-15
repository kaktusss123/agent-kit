import { describe, expect, test } from "bun:test";
import sessionTitleExtension from "./index";

type Handler = (event: any, ctx: any) => any;

class FakePi {
	readonly handlers = new Map<string, Handler[]>();
	private name?: string;
	setTitleCalls: string[] = [];
	completeCalls = 0;
	readonly model = { provider: "p", id: "m" };

	on(event: string, handler: Handler): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}
	emit(event: any, ctx: any = {}): void {
		for (const handler of this.handlers.get(event.type) ?? []) handler(event, ctx);
	}
	getSessionName(): string | undefined {
		return this.name;
	}
	setSessionName(name: string): void {
		this.name = name;
	}
}

/** Minimal TUI context: model registry answers with a title-shaped response. */
function tuiContext(pi: FakePi) {
	return {
		mode: "tui",
		model: pi.model,
		modelRegistry: {
			find: () => undefined,
			hasConfiguredAuth: () => false,
			complete: async () => {
				pi.completeCalls++;
				return {
					stopReason: "stop",
					content: [{ type: "text", text: "Fix flaky login" }],
				};
			},
		},
		ui: {
			setTitle: (name: string) => {
				pi.setTitleCalls.push(name);
			},
		},
	};
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("session-title before_agent_start boundary", () => {
	test("custom turn (no prompt) is ignored without throwing; later user prompt still titles", async () => {
		const pi = new FakePi();
		sessionTitleExtension(pi as never);
		const ctx = tuiContext(pi);

		// Idle custom turn: carries a message instead of a prompt.
		expect(() =>
			pi.emit(
				{ type: "before_agent_start", messageType: "custom", message: { customType: "x", content: "go on" } },
				ctx,
			),
		).not.toThrow();
		await flush();
		expect(pi.completeCalls).toBe(0);

		// The first real user prompt still triggers title generation.
		pi.emit({ type: "before_agent_start", messageType: "user", prompt: "Fix the flaky login test" }, ctx);
		await flush();
		expect(pi.completeCalls).toBe(1);
		expect(pi.getSessionName()).toBe("Fix flaky login");
	});

	test("legacy prompt-only user event still titles", async () => {
		const pi = new FakePi();
		sessionTitleExtension(pi as never);
		const ctx = tuiContext(pi);

		pi.emit({ type: "before_agent_start", prompt: "Fix the flaky login test" }, ctx);
		await flush();
		expect(pi.completeCalls).toBe(1);
		expect(pi.getSessionName()).toBe("Fix flaky login");
	});
});
