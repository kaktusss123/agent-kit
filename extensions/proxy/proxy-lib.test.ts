/**
 * Tests for the shared proxy state helpers and the pi-parity transport
 * option building (no undici installation: dispatcher installation is
 * exercised by the proxy harness instead; factories are tested against
 * EventEmitter fakes).
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { EventEmitter } from "node:events";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyProxyPreference,
	DEFAULT_HTTP_IDLE_TIMEOUT_MS,
	dispatcherMatchesPreference,
	httpIdleTimeoutMsFromSettings,
	parseHttpIdleTimeoutMs,
	piTransportOptions,
	readHttpIdleTimeoutMs,
	readProxyState,
	resolveAgentDir,
	setUndiciForTesting,
	type UndiciModule,
	undiciFactories,
	withUndiciErrorListener,
	writeProxyState,
} from "./proxy-lib";

function withAgentDir(fn: (dir: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-lib-test-"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		fn(dir);
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Async variant of withAgentDir for the applyProxyPreference tests. */
async function withAgentDirAsync(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-lib-test-"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		await fn(dir);
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("proxy-lib state", () => {
	test("resolveAgentDir honors PI_CODING_AGENT_DIR (pi's own env var)", () => {
		withAgentDir((dir) => {
			expect(resolveAgentDir()).toBe(dir);
		});
	});

	test("resolveAgentDir falls back to ~/.pi/agent", () => {
		const prev = process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_CODING_AGENT_DIR;
		try {
			expect(resolveAgentDir()).toBe(path.join(os.homedir(), ".pi", "agent"));
		} finally {
			if (prev !== undefined) process.env.PI_CODING_AGENT_DIR = prev;
		}
	});

	test("missing state file reads as disabled with default url", () => {
		withAgentDir(() => {
			expect(readProxyState()).toEqual({ enabled: false, url: "http://ai-proxy.idp.cloud.ru:8080" });
		});
	});

	test("write/read roundtrip preserves enabled and url", () => {
		withAgentDir((dir) => {
			writeProxyState({ enabled: true, url: "http://127.0.0.1:8802" });
			expect(readProxyState()).toEqual({ enabled: true, url: "http://127.0.0.1:8802" });
			expect(fs.existsSync(path.join(dir, "proxy-state.json"))).toBe(true);
			writeProxyState({ enabled: false, url: "http://127.0.0.1:8802" });
			expect(readProxyState().enabled).toBe(false);
		});
	});

	test("enabled state without url is normalized to the default url", () => {
		withAgentDir(() => {
			writeProxyState({ enabled: true, url: undefined });
			const state = readProxyState();
			expect(state.enabled).toBe(true);
			expect(state.url).toBe("http://ai-proxy.idp.cloud.ru:8080");
		});
	});
});

describe("proxy-lib transport parity (pi 0.85.1 configureHttpDispatcher)", () => {
	// EventEmitter fakes standing in for undici dispatcher classes.
	class FakeClient extends EventEmitter {}
	class FakePool extends EventEmitter {}
	class FakeEnvHttpProxyAgent extends EventEmitter {}
	class FakeAgent extends EventEmitter {}
	describe("parseHttpIdleTimeoutMs (pi parseHttpIdleTimeoutMs mirror)", () => {
		test("numbers: finite >= 0 pass floored, negatives/NaN/Infinity invalid", () => {
			expect(parseHttpIdleTimeoutMs(1_200_000)).toBe(1_200_000);
			expect(parseHttpIdleTimeoutMs(1500.9)).toBe(1500);
			expect(parseHttpIdleTimeoutMs(0)).toBe(0);
			expect(parseHttpIdleTimeoutMs(-1)).toBeUndefined();
			expect(parseHttpIdleTimeoutMs(Number.NaN)).toBeUndefined();
			expect(parseHttpIdleTimeoutMs(Number.POSITIVE_INFINITY)).toBeUndefined();
		});

		test('strings: "disabled" → 0, numeric strings parse, others invalid', () => {
			expect(parseHttpIdleTimeoutMs("disabled")).toBe(0);
			expect(parseHttpIdleTimeoutMs("DISABLED")).toBe(0);
			expect(parseHttpIdleTimeoutMs(" disabled ")).toBe(0);
			expect(parseHttpIdleTimeoutMs("600")).toBe(600);
			expect(parseHttpIdleTimeoutMs("abc")).toBeUndefined();
			expect(parseHttpIdleTimeoutMs("")).toBeUndefined();
		});

		test("non-string non-number values are invalid", () => {
			expect(parseHttpIdleTimeoutMs(undefined)).toBeUndefined();
			expect(parseHttpIdleTimeoutMs(null)).toBeUndefined();
			expect(parseHttpIdleTimeoutMs(true)).toBeUndefined();
			expect(parseHttpIdleTimeoutMs({})).toBeUndefined();
		});
	});

	describe("httpIdleTimeoutMsFromSettings (timeout source)", () => {
		test("configured timeout is used", () => {
			expect(httpIdleTimeoutMsFromSettings({ httpIdleTimeoutMs: 1_200_000 })).toBe(1_200_000);
			expect(httpIdleTimeoutMsFromSettings({ httpIdleTimeoutMs: "600" })).toBe(600);
		});

		test('"disabled" → 0 and 0 passes through as-is (no int32-max conversion)', () => {
			expect(httpIdleTimeoutMsFromSettings({ httpIdleTimeoutMs: "disabled" })).toBe(0);
			expect(httpIdleTimeoutMsFromSettings({ httpIdleTimeoutMs: 0 })).toBe(0);
		});

		test("missing or invalid setting → pi default 300s", () => {
			expect(httpIdleTimeoutMsFromSettings(undefined)).toBe(DEFAULT_HTTP_IDLE_TIMEOUT_MS);
			expect(httpIdleTimeoutMsFromSettings({})).toBe(DEFAULT_HTTP_IDLE_TIMEOUT_MS);
			expect(httpIdleTimeoutMsFromSettings({ httpIdleTimeoutMs: "nonsense" })).toBe(DEFAULT_HTTP_IDLE_TIMEOUT_MS);
			expect(httpIdleTimeoutMsFromSettings({ httpIdleTimeoutMs: -5 })).toBe(DEFAULT_HTTP_IDLE_TIMEOUT_MS);
			expect(DEFAULT_HTTP_IDLE_TIMEOUT_MS).toBe(300_000);
		});
	});

	test("readHttpIdleTimeoutMs reads settings.json from the pi agent dir", () => {
		withAgentDir((dir) => {
			fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 1_200_000 }));
			expect(readHttpIdleTimeoutMs()).toBe(1_200_000);
			fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: "disabled" }));
			expect(readHttpIdleTimeoutMs()).toBe(0);
			fs.writeFileSync(path.join(dir, "settings.json"), "{not json");
			expect(readHttpIdleTimeoutMs()).toBe(DEFAULT_HTTP_IDLE_TIMEOUT_MS);
		});
	});

	test("readHttpIdleTimeoutMs falls back to the default when settings.json is missing", () => {
		withAgentDir(() => {
			expect(readHttpIdleTimeoutMs()).toBe(DEFAULT_HTTP_IDLE_TIMEOUT_MS);
		});
	});

	test("piTransportOptions mirrors the pi dispatcher option block", () => {
		expect(piTransportOptions(1_200_000)).toEqual({
			allowH2: false,
			proxyTunnel: true,
			headersTimeout: 1_200_000,
			bodyTimeout: 1_200_000,
			connect: { autoSelectFamilyAttemptTimeout: 2_000 },
		});
		// 0 ("disabled") passes through unchanged.
		expect(piTransportOptions(0).headersTimeout).toBe(0);
		expect(piTransportOptions(0).bodyTimeout).toBe(0);
	});

	test("withUndiciErrorListener attaches an error listener to EventEmitters only", () => {
		const emitter = new EventEmitter();
		withUndiciErrorListener(emitter);
		expect(emitter.listenerCount("error")).toBe(1);
		// Must not throw when an error is emitted (listener swallows it).
		expect(() => emitter.emit("error", new Error("boom"))).not.toThrow();

		const plain = { on: () => {} };
		expect(withUndiciErrorListener(plain)).toBe(plain);
	});

	describe("undiciFactories (pooled client error listeners)", () => {
		const factories = undiciFactories({
			Client: FakeClient as unknown as new (origin: string, opts?: Record<string, unknown>) => unknown,
			Pool: FakePool as unknown as new (origin: string, opts?: Record<string, unknown>) => unknown,
		});

		test("clientFactory builds an error-listened Client", () => {
			const client = factories.clientFactory("http://origin", { headersTimeout: 5 }) as EventEmitter;
			expect(client).toBeInstanceOf(FakeClient);
			expect(client.listenerCount("error")).toBe(1);
		});

		test("factory: connections === 1 → single Client; otherwise Pool wired with clientFactory", () => {
			const single = factories.factory("http://origin", { connections: 1 }) as EventEmitter;
			expect(single).toBeInstanceOf(FakeClient);
			expect(single.listenerCount("error")).toBe(1);

			const pooled = factories.factory("http://origin", { connections: 4 }) as unknown as {
				listenerCount(ev: string): number;
				constructor: { name: string };
			};
			expect(pooled).toBeInstanceOf(FakePool);
			expect(pooled.listenerCount("error")).toBe(1);
		});
	});

	// The helper is covered above; these tests cover the applyProxyPreference
	// wiring itself: the TOP-LEVEL dispatcher this module installs (proxy ON
	// and OFF) must carry the unhandled-"error" listener, mirroring pi's
	// `withUndiciErrorListener(new undici.EnvHttpProxyAgent({...}))` install.
	describe("applyProxyPreference (top-level dispatcher wiring)", () => {
		function installFakeUndici(): void {
			const fake = {
				EnvHttpProxyAgent: FakeEnvHttpProxyAgent,
				Agent: FakeAgent,
				Client: FakeClient,
				Pool: FakePool,
			} as unknown as UndiciModule;
			setUndiciForTesting(fake);
		}

		async function installedDispatcher(): Promise<EventEmitter> {
			await applyProxyPreference();
			const current = (globalThis as Record<symbol, unknown>)[
				Symbol.for("undici.globalDispatcher.2")
			];
			expect(current).toBeInstanceOf(EventEmitter);
			return current as EventEmitter;
		}

		test("proxy ON: installed EnvHttpProxyAgent carries an error listener and keeps identity", async () => {
			await withAgentDirAsync(async (dir) => {
				fs.writeFileSync(
					path.join(dir, "proxy-state.json"),
					JSON.stringify({ enabled: true, url: "http://127.0.0.1:8802" }),
				);
				installFakeUndici();
				try {
					const dispatcher = await installedDispatcher();
					expect(dispatcher).toBeInstanceOf(FakeEnvHttpProxyAgent);
					expect(dispatcher.listenerCount("error")).toBe(1);
					// Swallowed, not thrown (the crash the listener defends against).
					expect(() => dispatcher.emit("error", new Error("boom"))).not.toThrow();
					// Wrap-then-store: the installed object is the tracked one.
					expect(dispatcherMatchesPreference(true)).toBe(true);
				} finally {
					setUndiciForTesting(undefined);
				}
			});
		});

		test("proxy OFF: installed Agent carries an error listener too", async () => {
			await withAgentDirAsync(async (dir) => {
				fs.writeFileSync(path.join(dir, "proxy-state.json"), JSON.stringify({ enabled: false }));
				installFakeUndici();
				try {
					const dispatcher = await installedDispatcher();
					expect(dispatcher).toBeInstanceOf(FakeAgent);
					expect(dispatcher.listenerCount("error")).toBe(1);
					expect(() => dispatcher.emit("error", new Error("boom"))).not.toThrow();
					expect(dispatcherMatchesPreference(false)).toBe(true);
				} finally {
					setUndiciForTesting(undefined);
				}
			});
		});
	});
});
