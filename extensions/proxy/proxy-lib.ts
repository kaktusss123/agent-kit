/**
 * Shared proxy mechanism for pi processes — Main and RPC children alike.
 *
 * Single source of truth: `proxy-state.json` in the pi agent dir
 * (`{ enabled: boolean, url?: string }`). This is a machine-level preference
 * for the Pi agent environment, not a per-chat setting. The Main extension
 * (../proxy-toggle.ts) and the subagent bridge (./subagents/bridge.ts) both
 * apply it through `applyProxyPreference()`.
 *
 * How application works: pi wires HTTP through an undici `EnvHttpProxyAgent`
 * installed as the global dispatcher at startup, and reinstalls a fresh
 * env-based dispatcher whenever runtime settings are reapplied (session
 * rebind, /reload, idle-timeout change). undici exposes the global dispatcher
 * under a `Symbol.for` key shared by every undici copy in the process, so
 * installing a dispatcher here redirects pi's own fetch immediately — no
 * restart. Because pi's reinstall path rebuilds from HTTP_PROXY/HTTPS_PROXY
 * env, this module deliberately does NOT export proxy env: bash children
 * (git, gh, MCP servers) must stay direct so corp-internal hosts remain
 * reachable. Instead, callers re-apply on `session_start` (after pi's
 * startup installs) and `before_agent_start` (which also self-heals a missed
 * live push: the next model request converges to the persisted preference).
 *
 * NO_PROXY semantics: `EnvHttpProxyAgent` evaluates NO_PROXY for every URL,
 * so hosts listed there (localhost, corp domains) bypass the proxy even when
 * the preference is ON.
 *
 * Transport parity (mirrors pi 0.85.1 `dist/core/http-dispatcher.js`
 * `configureHttpDispatcher`): pi installs its env dispatcher with
 * `allowH2:false, proxyTunnel:true, headersTimeout/bodyTimeout = httpIdleTimeoutMs
 * (settings.json), connect.autoSelectFamilyAttemptTimeout:2000` and wraps the
 * dispatcher and every pooled client in an unhandled-"error" listener (undici
 * can emit an internal client "error" while terminating a mid-stream body).
 * undici defaults headers/body timeouts to 300s when the options are absent —
 * installing a dispatcher without them silently degrades pi's configured
 * timeout (long buffered responses die at 300s with UND_ERR_HEADERS_TIMEOUT).
 * This module therefore rebuilds the same transport options for BOTH proxy
 * states (ON and OFF) and — exactly like pi — wraps the installed top-level
 * dispatcher and every pooled client in `withUndiciErrorListener` (undici
 * Dispatcher is an EventEmitter; an unhandled internal "error" would crash
 * the process). COUPLING: the option set mirrors pi 0.85.1 and must be
 * revisited whenever pi or its undici copy is upgraded.
 *
 * The undici copy used to build dispatchers is resolved from the running pi
 * entry, so the dispatcher class always matches the undici implementation pi
 * itself installed.
 */

import fs from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";

export interface ProxyState {
	enabled: boolean;
	url?: string;
}

/** Fallback corp AI-gateway (documented default; PI_PROXY env overrides). */
const DEFAULT_PROXY_URL = "http://ai-proxy.idp.cloud.ru:8080";

const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.2");

/**
 * Timeout pi falls back to when `httpIdleTimeoutMs` is missing or invalid
 * (pi: `getHttpIdleTimeoutMs() ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS`).
 */
export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

/** Pi: Node's 250ms default can kill valid connection attempts on high-latency routes. */
const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

export type UndiciModule = {
	EnvHttpProxyAgent: new (opts: Record<string, unknown>) => unknown;
	Agent: new (opts?: Record<string, unknown>) => unknown;
	Client: new (origin: string, opts?: Record<string, unknown>) => unknown;
	Pool: new (origin: string, opts?: Record<string, unknown>) => unknown;
};

/**
 * Mirror of pi 0.85.1 `parseHttpIdleTimeoutMs` (settings-manager /
 * http-dispatcher): numbers must be finite and >= 0 (floored); "disabled" →
 * 0; numeric strings go through the number path; everything else (including
 * empty strings) is invalid → undefined.
 */
export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") return 0;
		if (trimmed.length === 0) return undefined;
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return Math.floor(value);
}

/**
 * Effective transport timeout from a parsed settings.json object: pi's
 * `getHttpIdleTimeoutMs()` semantics (`parse ?? DEFAULT`), except an invalid
 * present value falls back to the default instead of throwing (this module
 * reads the file directly and must never fail the process over a setting).
 * `0` ("disabled") passes through as-is — dispatcher semantics, no int32-max
 * conversion.
 */
export function httpIdleTimeoutMsFromSettings(settings: unknown): number {
	const value = (settings as Record<string, unknown> | null | undefined)?.httpIdleTimeoutMs;
	return parseHttpIdleTimeoutMs(value) ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
}

/**
 * Transport options shared by every dispatcher this module installs, mirrored
 * from pi 0.85.1 `configureHttpDispatcher`. Pure — see proxy-lib.test.ts.
 */
export function piTransportOptions(timeoutMs: number): {
	allowH2: false;
	proxyTunnel: true;
	headersTimeout: number;
	bodyTimeout: number;
	connect: { autoSelectFamilyAttemptTimeout: number };
} {
	return {
		allowH2: false,
		// Keep HTTP origins on CONNECT tunnels as they were before undici 8.7.
		proxyTunnel: true,
		headersTimeout: timeoutMs,
		bodyTimeout: timeoutMs,
		connect: { autoSelectFamilyAttemptTimeout: AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS },
	};
}

const ignoreUndiciDispatcherError = (_error: unknown) => {};

/**
 * Mirror of pi's `withUndiciErrorListener`: undici can emit an internal
 * client "error" while terminating a mid-stream fetch body; without a
 * listener, EventEmitter's special-cased unhandled "error" crashes the
 * process. The body stream itself still rejects through reader.read().
 */
export function withUndiciErrorListener<T>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
	}
	return dispatcher;
}

/** Pooled-client factories mirroring pi's createUndiciClient/createUndiciOriginDispatcher. */
export function undiciFactories(undici: Pick<UndiciModule, "Client" | "Pool">): {
	clientFactory: (origin: string, opts?: Record<string, unknown>) => unknown;
	factory: (origin: string, opts?: Record<string, unknown>) => unknown;
} {
	const clientFactory = (origin: string, opts?: Record<string, unknown>) =>
		withUndiciErrorListener(new undici.Client(origin, opts));
	const factory = (origin: string, opts?: Record<string, unknown>) => {
		const dispatcherOptions = opts ?? {};
		if ((dispatcherOptions as { connections?: number }).connections === 1) {
			return clientFactory(origin, dispatcherOptions);
		}
		return withUndiciErrorListener(new undici.Pool(origin, { ...dispatcherOptions, factory: clientFactory }));
	};
	return { clientFactory, factory };
}

let undiciPromise: Promise<UndiciModule> | undefined;

/**
 * Test seam: install a fake undici module (used by applyProxyPreference's
 * dispatcher construction) without touching resolution. Pass undefined to
 * restore normal resolution. Unit tests only.
 */
export function setUndiciForTesting(undici: UndiciModule | undefined): void {
	undiciPromise = undici ? Promise.resolve(undici) : undefined;
}

/** createRequire anchored at the running pi entry (symlinks resolved). */
function piRequire(): NodeJS.Require | undefined {
	try {
		const entry = process.argv[1];
		if (entry) return createRequire(fs.realpathSync(entry));
	} catch {
		// Fall through to normal resolution.
	}
	return undefined;
}

function loadUndici(): Promise<UndiciModule> {
	undiciPromise ??= (async () => {
		const req = piRequire();
		if (req) {
			try {
				// The undici copy pi itself uses.
				return (await import(req.resolve("undici"))) as UndiciModule;
			} catch {
				// Fall back to normal resolution.
			}
		}
		try {
			return (await import("undici")) as UndiciModule;
		} catch {
			throw new Error(
				"proxy: cannot resolve undici (not in the pi package and not next to the extension)",
			);
		}
	})();
	return undiciPromise;
}

/** Same agent dir pi uses (PI_CODING_AGENT_DIR), so state and CA stay co-located. */
export function resolveAgentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) {
		if (env === "~") return os.homedir();
		if (env.startsWith("~/")) return join(os.homedir(), env.slice(2));
		return env;
	}
	return join(os.homedir(), ".pi", "agent");
}

function stateFilePath(): string {
	return join(resolveAgentDir(), "proxy-state.json");
}

function settingsFilePath(): string {
	return join(resolveAgentDir(), "settings.json");
}

/**
 * Read `httpIdleTimeoutMs` from the pi settings file directly (same pattern
 * as proxy-state.json — no private pi imports). Missing file, unparsable
 * JSON, missing or invalid setting → the pi default (300s); "disabled" → 0.
 */
export function readHttpIdleTimeoutMs(): number {
	try {
		const raw = JSON.parse(fs.readFileSync(settingsFilePath(), "utf8"));
		return httpIdleTimeoutMsFromSettings(raw);
	} catch {
		return DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	}
}

/** Corp MITM CA chain (AI Proxy CA / SberCloud); needed for proxy TLS. */
function loadCorpCa(): string | undefined {
	try {
		const pem = fs.readFileSync(join(resolveAgentDir(), "corp-ca.pem"), "utf8");
		return pem.includes("BEGIN CERTIFICATE") ? pem : undefined;
	} catch {
		return undefined;
	}
}

export function readProxyState(): ProxyState {
	const defaultUrl = process.env.PI_PROXY ?? DEFAULT_PROXY_URL;
	try {
		const raw = JSON.parse(fs.readFileSync(stateFilePath(), "utf8")) as ProxyState;
		if (raw.enabled && !raw.url) raw.url = defaultUrl;
		return raw;
	} catch {
		return { enabled: false, url: defaultUrl };
	}
}

export function writeProxyState(state: ProxyState): void {
	fs.writeFileSync(stateFilePath(), `${JSON.stringify(state, null, 2)}\n`);
}

/** What this process last installed, to detect later clobbering cheaply. */
let installed: { enabled: boolean; agent: unknown } | null = null;

/** True when the process's current global dispatcher realizes `enabled`. */
export function dispatcherMatchesPreference(enabled: boolean): boolean {
	const current = (globalThis as Record<symbol, unknown>)[GLOBAL_DISPATCHER];
	return installed !== null && installed.enabled === enabled && installed.agent === current;
}

/** Read the persisted preference and install the matching dispatcher now. */
export async function applyProxyPreference(): Promise<ProxyState> {
	const state = readProxyState();
	const undici = await loadUndici();
	// Pi transport parity (see module docstring): both branches carry the same
	// timeout/connect semantics pi itself installs, so the configured
	// httpIdleTimeoutMs survives the dispatcher replacement in either state.
	const transport = piTransportOptions(readHttpIdleTimeoutMs());
	const factories = undiciFactories(undici);
	let agent: unknown;
	if (state.enabled && state.url) {
		const ca = loadCorpCa();
		// Pi wraps the top-level dispatcher itself (withUndiciErrorListener
		// before setGlobalDispatcher) — mirror that in BOTH branches, not just
		// the pooled clients. Wrap-then-store keeps the object identity, so
		// dispatcherMatchesPreference's installed-agent comparison still works.
		agent = withUndiciErrorListener(new undici.EnvHttpProxyAgent({
			httpProxy: state.url,
			httpsProxy: state.url,
			...transport,
			// The corp CA rides inside `connect` (TLS to the proxy) — merged with
			// the parity connect options instead of clobbered by the spread.
			...(ca ? { requestTls: { ca }, connect: { ...transport.connect, ca } } : {}),
			clientFactory: factories.clientFactory,
			factory: factories.factory,
		}));
	} else {
		agent = withUndiciErrorListener(new undici.Agent({
			...transport,
			// Same origin-dispatcher shape as Agent's default (Client when
			// connections === 1, else Pool of error-listened clients).
			factory: factories.factory,
		}));
	}
	(globalThis as Record<symbol, unknown>)[GLOBAL_DISPATCHER] = agent;
	installed = { enabled: state.enabled, agent };
	return state;
}

/**
 * Re-apply only when the current dispatcher drifted from the persisted
 * preference (cheap: one small file read, no install on the happy path).
 */
export async function reapplyIfDrifted(): Promise<ProxyState> {
	const state = readProxyState();
	if (!dispatcherMatchesPreference(state.enabled)) {
		return applyProxyPreference();
	}
	return state;
}
