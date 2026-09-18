/**
 * Tests for the parent-side wiring that feeds provider-extension resolution:
 * package enumeration must bind the LIVE parent facts — the ctx cwd of the
 * refresh moment and the project trust state — into the SettingsManager /
 * DefaultPackageManager construction. After a session rebind the wrong
 * project's packages must not be read, and an UNTRUSTED project's
 * settings.json `packages` must never flow into a child `-e` (that would be
 * local code execution of untrusted content).
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeParentPackageLister, type PackageManagerWiring } from "./index";

function recordingWiring() {
	const settingsCalls: Array<{ cwd: string; agentDir: string; projectTrusted: boolean }> = [];
	const pmCalls: Array<{ cwd: string; agentDir: string; settings: unknown }> = [];
	const wiring: PackageManagerWiring = {
		agentDir: () => "/agent-dir",
		createSettingsManager: (cwd, agentDir, options) => {
			settingsCalls.push({ cwd, agentDir, projectTrusted: options.projectTrusted });
			return { fake: "settings-manager" };
		},
		createPackageManager: (options) => {
			pmCalls.push({ cwd: options.cwd, agentDir: options.agentDir, settings: options.settingsManager });
			return {
				listConfiguredPackages: () => [{ source: "git:example/pkg", installedPath: "/pkg" }],
			};
		},
	};
	return { wiring, settingsCalls, pmCalls };
}

describe("parent package lister wiring (live parent facts)", () => {
	test("threads the captured cwd/trust into the settings manager and the package manager", () => {
		const { wiring, settingsCalls, pmCalls } = recordingWiring();
		const list = makeParentPackageLister({ cwd: "/live/parent/cwd", projectTrusted: true }, wiring)();
		expect(list).toEqual([{ source: "git:example/pkg", installedPath: "/pkg" }]);
		expect(settingsCalls).toEqual([{ cwd: "/live/parent/cwd", agentDir: "/agent-dir", projectTrusted: true }]);
		expect(pmCalls).toEqual([
			{ cwd: "/live/parent/cwd", agentDir: "/agent-dir", settings: { fake: "settings-manager" } },
		]);
	});

	test("untrusted project: projectTrusted=false reaches the settings manager", () => {
		const { wiring, settingsCalls, pmCalls } = recordingWiring();
		makeParentPackageLister({ cwd: "/untrusted/project", projectTrusted: false }, wiring)();
		expect(settingsCalls).toEqual([
			{ cwd: "/untrusted/project", agentDir: "/agent-dir", projectTrusted: false },
		]);
		expect(pmCalls[0]?.cwd).toBe("/untrusted/project");
	});

	test("every invocation uses the fact snapshot it was bound to (rebind-safe)", () => {
		const { wiring, settingsCalls } = recordingWiring();
		makeParentPackageLister({ cwd: "/before-rebind", projectTrusted: true }, wiring)();
		makeParentPackageLister({ cwd: "/after-rebind", projectTrusted: false }, wiring)();
		expect(settingsCalls.map((c) => c.cwd)).toEqual(["/before-rebind", "/after-rebind"]);
		expect(settingsCalls.map((c) => c.projectTrusted)).toEqual([true, false]);
	});
});

/**
 * The real pi classes: pins the EXACT SettingsManagerCreateOptions semantics
 * we rely on — `projectTrusted: false` skips the project settings load
 * entirely (user scope untouched). A typo in the options field name would
 * silently restore trust and this test would catch it.
 */
describe("real pi wiring (installed @earendil-works/pi-coding-agent)", () => {
	function tmpDir(prefix: string): string {
		return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	}

	test("projectTrusted=false hides project packages, user packages stay visible", () => {
		const agentDir = tmpDir("akit-wiring-agent-");
		const projectDir = tmpDir("akit-wiring-project-");
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["git:user/pkg"] }));
		fs.mkdirSync(path.join(projectDir, ".pi"));
		fs.writeFileSync(
			path.join(projectDir, ".pi", "settings.json"),
			JSON.stringify({ packages: ["git:untrusted/pkg"] }),
		);
		const prev = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const trusted = makeParentPackageLister({ cwd: projectDir, projectTrusted: true })();
			expect(trusted.map((p) => p.source).sort()).toEqual(["git:untrusted/pkg", "git:user/pkg"]);

			const untrusted = makeParentPackageLister({ cwd: projectDir, projectTrusted: false })();
			expect(untrusted.map((p) => p.source)).toEqual(["git:user/pkg"]);
			expect(untrusted.every((p) => p.installedPath === undefined)).toBe(true); // not installed ⇒ skipped
		} finally {
			if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prev;
			fs.rmSync(agentDir, { recursive: true, force: true });
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});
});
