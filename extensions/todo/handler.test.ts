import { describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import todoExtension from "./index.ts";

type Handler = (event: any, ctx: any) => any;

/**
 * Boundary: idle custom turns (message instead of a prompt) pass through
 * the per-turn handler without throwing. The eager prelude is dormant by
 * default, so this exercises the contract guard, not the prelude itself.
 */
describe("todo before_agent_start boundary", () => {
	test("custom turn (no prompt) resolves without throwing and injects nothing", async () => {
		const handlers = new Map<string, Handler[]>();
		const pi = {
			on: (event: string, handler: Handler) => {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			registerTool: () => {},
			registerCommand: () => {},
			sendMessage: async () => {},
		};
		todoExtension(pi as never);

		const beforeStart = handlers.get("before_agent_start") ?? [];
		expect(beforeStart.length).toBe(1);
		const results = await Promise.all(
			beforeStart.map((handler) =>
				handler(
					{ type: "before_agent_start", messageType: "custom", message: { customType: "x", content: "go on" } },
					{},
				),
			),
		);
		expect(results).toEqual([undefined]);
	});

	test("legacy prompt-only user event resolves without throwing", async () => {
		const handlers = new Map<string, Handler[]>();
		const pi = {
			on: (event: string, handler: Handler) => {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			registerTool: () => {},
			registerCommand: () => {},
			sendMessage: async () => {},
		};
		todoExtension(pi as never);

		const beforeStart = handlers.get("before_agent_start") ?? [];
		const results = await Promise.all(
			beforeStart.map((handler) => handler({ type: "before_agent_start", prompt: "do work" }, {})),
		);
		expect(results).toEqual([undefined]);
	});
});
