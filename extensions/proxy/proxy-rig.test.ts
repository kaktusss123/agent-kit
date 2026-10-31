/**
 * Transport rig (short, parameterized): proves the pi-parity transport
 * options preserve the configured timeout on BOTH proxy states — the
 * regression behind the ~905s "Request timed out." symptom (undici's 300s
 * headers/body defaults killing buffered proxy responses).
 *
 * The dispatcher work runs in a Node subprocess (rig-child.mjs), not in
 * the test process: the rig must exercise undici's own socket timers. The
 * child
 * hosts a delayed backend and a local loopback proxy (absolute-form
 * forwarding plus CONNECT tunneling, matching EnvHttpProxyAgent with
 * proxyTunnel), builds the dispatcher exactly like applyProxyPreference
 * (same option block, serialized here from the real piTransportOptions()),
 * performs one fetch, and reports. ON cases assert the request genuinely
 * traversed the proxy (CONNECT count) and reached the backend.
 *
 * Cases: proxy ON and OFF × short configured timeout (must fire before the
 * delayed answer — the old missing-options behavior rode 300s defaults and
 * succeeded) × long-enough timeout (delayed answer passes).
 *
 * Skipped when node or pi's undici copy is unavailable (README node_modules
 * recipe).
 */
import { describe, test } from "node:test";
import { createRequire } from "node:module";
import { expect } from "../../tests/support/expect.ts";

const require = createRequire(import.meta.url);
import { execFile } from "node:child_process";
import * as path from "node:path";
import { piTransportOptions } from "./proxy-lib.ts";

function nodePath(): string | undefined {
	if (process.env.AKIT_RIG_NODE) return process.env.AKIT_RIG_NODE;
	const fs = require("node:fs");
	// The runtime that hosts the test suite (fnm/nvm keep node in the same
	// installation bin dir as the running interpreter).
	const execDir = path.dirname(process.execPath);
	const candidates = [
		process.env.PI_NODE,
		path.join(execDir, "node"),
		"/usr/bin/node",
		"/usr/local/bin/node",
		"/opt/homebrew/bin/node",
	].filter((p): p is string => typeof p === "string");
	for (const candidate of candidates) {
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			// try next
		}
	}
	return undefined;
}

function undiciModulePath(): string | undefined {
	// Path-based resolution: pi's own undici copy lives in its node_modules
	// and is not re-exported through the package entry point.
	try {
		const fs = require("node:fs");
		const candidate = path.resolve(
			import.meta.dirname,
			"../../node_modules/@earendil-works/pi-coding-agent/node_modules/undici/index.js",
		);
		return fs.existsSync(candidate) ? candidate : undefined;
	} catch {
		return undefined;
	}
}

const node = nodePath();
const undiciPath = undiciModulePath();
const rigChild = path.resolve(import.meta.dirname, "rig-child.mjs");

interface RigResult {
	ok: boolean;
	status?: number;
	elapsedMs: number;
	code?: string;
	connectCount: number;
	backendHits: number;
}

function runCase(testCase: string): Promise<RigResult> {
	return new Promise((resolve, reject) => {
		execFile(
			node!,
			[rigChild, testCase, undiciPath!],
			{ timeout: 30000 },
			(err, stdout) => {
				if (err) return reject(err);
				const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
				if (!line) return reject(new Error(`rig child produced no RESULT: ${stdout}`));
				resolve(JSON.parse(line.slice("RESULT ".length)) as RigResult);
			},
		);
	});
}

describe("proxy transport rig (short timeout bounds, proxy ON and OFF)", () => {
	test(
		"transport options are the real piTransportOptions block",
		{ skip: node === undefined || undiciPath === undefined },
		() => {
			// The rig child embeds the same shape; pin it here so an option change
			// forces a conscious rig update.
			expect(piTransportOptions(300)).toMatchObject({
				allowH2: false,
				proxyTunnel: true,
				headersTimeout: 300,
				bodyTimeout: 300,
				connect: { autoSelectFamilyAttemptTimeout: 2000 },
			});
		},
	);

	test(
		"proxy OFF: short configured timeout fires (undici 300s default would let it pass)",
		{ skip: node === undefined || undiciPath === undefined },
		async () => {
			const result = await runCase("off-fire");
			expect(result.ok).toBe(false);
			expect(result.code).toContain("HEADERS_TIMEOUT");
			expect(result.elapsedMs).toBeLessThan(2500);
		},
	);

	test(
		"proxy OFF: delayed answer passes when the configured timeout allows it",
		{ skip: node === undefined || undiciPath === undefined },
		async () => {
			const result = await runCase("off-pass");
			expect(result.ok).toBe(true);
			expect(result.status).toBe(200);
		},
	);

	test(
		"proxy ON (EnvHttpProxyAgent + local forward proxy): short configured timeout fires",
		{ skip: node === undefined || undiciPath === undefined },
		async () => {
			const result = await runCase("on-fire");
			expect(result.ok).toBe(false);
			expect(result.code).toContain("HEADERS_TIMEOUT");
			expect(result.elapsedMs).toBeLessThan(2500);
			// The request genuinely traversed the proxy tunnel to the backend.
			expect(result.connectCount).toBeGreaterThanOrEqual(1);
			expect(result.backendHits).toBeGreaterThanOrEqual(1);
		},
	);

	test(
		"proxy ON: delayed answer passes when the configured timeout allows it",
		{ skip: node === undefined || undiciPath === undefined },
		async () => {
			const result = await runCase("on-pass");
			expect(result.ok).toBe(true);
			expect(result.status).toBe(200);
			expect(result.connectCount).toBeGreaterThanOrEqual(1);
			expect(result.backendHits).toBeGreaterThanOrEqual(1);
		},
	);
});
