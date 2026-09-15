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
 * The undici copy used to build dispatchers is resolved from the running pi
 * entry, so the dispatcher class always matches the undici implementation pi
 * itself installed.
 */

import fs from "node:fs";
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

type UndiciModule = {
	EnvHttpProxyAgent: new (opts: Record<string, unknown>) => unknown;
	Agent: new (opts?: Record<string, unknown>) => unknown;
};

let undiciPromise: Promise<UndiciModule> | undefined;

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
	let agent: unknown;
	if (state.enabled && state.url) {
		const ca = loadCorpCa();
		agent = new undici.EnvHttpProxyAgent({
			httpProxy: state.url,
			httpsProxy: state.url,
			...(ca ? { requestTls: { ca }, connect: { ca } } : {}),
		});
	} else {
		agent = new undici.Agent();
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
