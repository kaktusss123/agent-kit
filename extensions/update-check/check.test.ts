import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
	CHECK_INTERVAL_MS,
	decide,
	offMainMessage,
	parseLsRemote,
	readUpdateState,
	updateMessage,
	writeUpdateState,
	type UpdateState,
} from "./check";

const freshUpToDate = (lastCheck: number): UpdateState => ({
	v: 1,
	lastCheck,
	status: "up-to-date",
});

const outdated = (lastCheck: number, head: string, remote: string): UpdateState => ({
	v: 1,
	lastCheck,
	status: "outdated",
	head,
	remote,
	upstream: "origin/main",
});

const HEAD = "a".repeat(40);
const REMOTE = "b".repeat(40);

describe("update state cache", () => {
	test("missing or corrupt file reads as null", () => {
		const dir = mkdtempSync(join(tmpdir(), "update-check-"));
		try {
			expect(readUpdateState(join(dir, "absent.json"))).toBeNull();
			const file = join(dir, "state", "update-check.json");
			writeUpdateState(file, freshUpToDate(1234));
			expect(readUpdateState(file)).toEqual(freshUpToDate(1234));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("invalid payloads are rejected, not thrown", () => {
		const dir = mkdtempSync(join(tmpdir(), "update-check-"));
		try {
			const file = join(dir, "broken.json");
			for (const raw of ["", "not json", '{"v":2}', '{"v":1,"status":"weird"}', '{"v":1,"status":"up-to-date"}']) {
				writeFileSync(file, raw);
				expect(readUpdateState(file)).toBeNull();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("decide", () => {
	test("absent cache asks for a network check", () => {
		expect(decide(null, HEAD, 1_000)).toEqual({ action: "check" });
	});

	test("unreadable HEAD stays silent", () => {
		expect(decide(null, null, 1_000)).toEqual({ action: "skip" });
		expect(decide(outdated(0, HEAD, REMOTE), null, 1_000)).toEqual({ action: "skip" });
	});

	test("fresh up-to-date cache skips, stale cache re-checks", () => {
		expect(decide(freshUpToDate(1_000), HEAD, 1_000 + CHECK_INTERVAL_MS - 1)).toEqual({ action: "skip" });
		expect(decide(freshUpToDate(1_000), HEAD, 1_000 + CHECK_INTERVAL_MS)).toEqual({ action: "check" });
	});

	test("cached outdated toasts without network while HEAD has not moved", () => {
		expect(decide(outdated(0, HEAD, REMOTE), HEAD, 1_000)).toEqual({ action: "notify" });
	});

	test("moved HEAD after a cached outdated re-checks the network", () => {
		expect(decide(outdated(0, HEAD, REMOTE), REMOTE, 1_000)).toEqual({ action: "check" });
	});

	test("HEAD matching the seen upstream means quietly refreshed", () => {
		expect(decide(outdated(0, HEAD, HEAD), HEAD, 1_000)).toEqual({ action: "skip" });
	});
});

describe("parseLsRemote", () => {
	test("first non-empty line yields the sha", () => {
		expect(parseLsRemote(`${REMOTE}\trefs/heads/main\n`)).toBe(REMOTE);
		expect(parseLsRemote("\n" + `${REMOTE}\trefs/heads/main\n`)).toBe(REMOTE);
	});

	test("empty or malformed output yields null", () => {
		expect(parseLsRemote("")).toBeNull();
		expect(parseLsRemote("\n")).toBeNull();
		expect(parseLsRemote("not a sha\trefs/heads/main\n")).toBeNull();
	});
});

describe("updateMessage", () => {
	test("names the command, optionally the upstream", () => {
		expect(updateMessage()).toBe("agent-kit: update available — run 'agent-kit update'");
		expect(updateMessage("origin/main")).toBe(
			"agent-kit: update available (behind origin/main) — run 'agent-kit update'",
		);
	});
});

describe("offMainMessage", () => {
	test("names branch, default and the exact switch-back command", () => {
		expect(offMainMessage("feat/update_check", "main", "/srv/kit")).toBe(
			"agent-kit: active checkout is on 'feat/update_check', not main — run: git -C /srv/kit switch main && agent-kit update",
		);
	});
});
