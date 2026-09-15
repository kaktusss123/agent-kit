/**
 * Tests for the shared proxy state helpers (no undici / no pi runtime needed:
 * dispatcher installation is exercised by the proxy harness instead).
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readProxyState, resolveAgentDir, writeProxyState } from "./proxy-lib";

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
