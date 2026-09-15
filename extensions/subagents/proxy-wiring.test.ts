/**
 * Tests for the proxy-changed → proxy-push-result wiring in the subagents
 * extension (no-runtime branch; the runtime branch is covered by the
 * controller push tests and the proxy harness).
 */
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Handler = (data: unknown) => void;

function makePi() {
	const listeners = new Map<string, Handler[]>();
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const events = {
		on(channel: string, handler: Handler) {
			const list = listeners.get(channel) ?? [];
			list.push(handler);
			listeners.set(channel, list);
			return () => {
				const i = list.indexOf(handler);
				if (i !== -1) list.splice(i, 1);
			};
		},
		emit(channel: string, data: unknown) {
			emitted.push({ channel, data });
			for (const handler of listeners.get(channel) ?? []) handler(data);
		},
	};
	const pi = {
		events,
		on() {},
		registerTool() {},
		registerCommand() {},
		sendMessage() {},
	} as unknown as ExtensionAPI;
	return { pi, emitted };
}

describe("proxy-changed wiring", () => {
	test("reports an empty push when the runtime was never started", async () => {
		const { default: extension } = await import("./index");
		const { pi, emitted } = makePi();
		extension(pi);
		pi.events.emit("proxy-changed", { enabled: true });
		await new Promise((r) => setTimeout(r, 20));
		const result = emitted.find((e) => e.channel === "proxy-push-result");
		expect(result).toBeDefined();
		expect(result!.data).toMatchObject({ enabled: true, acked: 0, total: 0 });
	});

	test("disabled preference is propagated as-is", async () => {
		const { default: extension } = await import("./index");
		const { pi, emitted } = makePi();
		extension(pi);
		pi.events.emit("proxy-changed", { enabled: false });
		await new Promise((r) => setTimeout(r, 20));
		const result = emitted.find((e) => e.channel === "proxy-push-result");
		expect(result).toBeDefined();
		expect(result!.data).toMatchObject({ enabled: false, acked: 0, total: 0 });
	});
});
