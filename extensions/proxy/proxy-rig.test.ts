/**
 * Transport rig (short, parameterized): proves the pi-parity transport
 * options preserve the configured timeout on BOTH proxy states — the
 * regression behind the ~905s "Request timed out." symptom (undici's 300s
 * headers/body defaults killing buffered proxy responses).
 *
 * The dispatcher work runs in a NODE subprocess (rig-child.mjs): bun does
 * not reproduce undici's socket timer semantics, so the rig would silently
 * pass under bun's runtime even with the old broken options. The child
 * hosts a delayed backend and a local forward proxy, builds the dispatcher
 * exactly like applyProxyPreference (same option block, serialized here
 * from the real piTransportOptions()), performs one fetch, and reports.
 *
 * Cases: proxy ON and OFF × short configured timeout (must fire before the
 * delayed answer — the old missing-options behavior rode 300s defaults and
 * succeeded) × long-enough timeout (delayed answer passes).
 *
 * The 330 s live verification of the same behavior at the real magnitude
 * lives in the research probes (b2-rig); this suite keeps a fast bound.
 *
 * Skipped when node or pi's undici copy is unavailable (README node_modules
 * recipe).
 */
import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { piTransportOptions } from "./proxy-lib";

function nodePath(): string | undefined {
	if (process.env.AKIT_RIG_NODE) return process.env.AKIT_RIG_NODE;
	const fs = require("node:fs");
	// The runtime that hosts the test suite: bun typically lives next to node
	// in the same installation bin dir (fnm/nvm layout).
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
	// Path-based resolution (bun's require.resolve returns bare specifiers for
	// nested deps): pi's own undici copy lives in its node_modules.
	try {
		const fs = require("node:fs");
		const candidate = path.resolve(
			import.meta.dir,
			"../../node_modules/@earendil-works/pi-coding-agent/node_modules/undici/index.js",
		);
		return fs.existsSync(candidate) ? candidate : undefined;
	} catch {
		return undefined;
	}
}

const node = nodePath();
const undiciPath = undiciModulePath();
const rigChild = path.resolve(import.meta.dir, "rig-child.mjs");

interface RigResult {
	ok: boolean;
	status?: number;
	elapsedMs: number;
	code?: string;
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
	test.skipIf(node === undefined || undiciPath === undefined)(
		"transport options are the real piTransportOptions block",
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

	test.skipIf(node === undefined || undiciPath === undefined)(
		"proxy OFF: short configured timeout fires (undici 300s default would let it pass)",
		async () => {
			const result = await runCase("off-fire");
			expect(result.ok).toBe(false);
			expect(result.code).toContain("HEADERS_TIMEOUT");
			expect(result.elapsedMs).toBeLessThan(2500);
		},
		20000,
	);

	test.skipIf(node === undefined || undiciPath === undefined)(
		"proxy OFF: delayed answer passes when the configured timeout allows it",
		async () => {
			const result = await runCase("off-pass");
			expect(result.ok).toBe(true);
			expect(result.status).toBe(200);
		},
		20000,
	);

	test.skipIf(node === undefined || undiciPath === undefined)(
		"proxy ON (EnvHttpProxyAgent + local forward proxy): short configured timeout fires",
		async () => {
			const result = await runCase("on-fire");
			expect(result.ok).toBe(false);
			expect(result.code).toContain("HEADERS_TIMEOUT");
			expect(result.elapsedMs).toBeLessThan(2500);
		},
		20000,
	);

	test.skipIf(node === undefined || undiciPath === undefined)(
		"proxy ON: delayed answer passes when the configured timeout allows it",
		async () => {
			const result = await runCase("on-pass");
			expect(result.ok).toBe(true);
			expect(result.status).toBe(200);
		},
		20000,
	);
});
