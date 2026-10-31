/**
 * ZAVOD-39 UX revision — automatic bounded `lastAssistantText` projection.
 *
 * The single most recent PUBLIC assistant speech of a child, captured from
 * completed `message_end` events (text blocks only), normalized and capped,
 * exposed at the AgentSnapshot/AgentResult root for plain and workspace
 * children alike. Separate channel from report_progress/RunHistory; no
 * thinking, tool calls, tool results, delta streams or transcripts.
 */
import { describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	LAST_TEXT_MAX,
	normalizeLastText,
	publicAssistantText,
	validateLastAssistantText,
} from "./last-text.ts";
import { LocalSubagentRuntime } from "./controller.ts";
import {
	autoAcceptPrompt,
	createFakeSpawnFactory,
	type FakeRpcProcess,
	settleRun,
} from "./fake-rpc.ts";
import { loadResult } from "./result-store.ts";
import { agentDetailView } from "./index.ts";
import type { AgentSnapshot } from "./types.ts";

// ---------------------------------------------------------- pure extraction

const textBlock = (text: string) => ({ type: "text", text });
const thinkingBlock = (thinking: string) => ({ type: "thinking", thinking });
const toolCallBlock = { type: "toolCall", id: "tc-1", name: "bash" };

describe("publicAssistantText (pure)", () => {
	test("mixed content: only text blocks count; thinking and tool calls never enter", () => {
		const raw = publicAssistantText({
			role: "assistant",
			stopReason: "toolUse",
			content: [
				thinkingBlock("hidden chain of thought"),
				textBlock("Reading the spec and environment."),
				toolCallBlock,
				textBlock("Now the tests."),
			],
		});
		expect(raw).toBe("Reading the spec and environment.\nNow the tests.");
	});

	for (const stopReason of ["error", "aborted", "deferred", "pending"] as const) {
		test(
			`${stopReason} stopReason is not completed public speech`,
			() => {
				expect(publicAssistantText({ role: "assistant", stopReason, content: [textBlock("never shown")] })).toBeUndefined();
			},
		);
	}

	test("absent/invalid shapes return undefined", () => {
		expect(publicAssistantText(undefined)).toBeUndefined();
		expect(publicAssistantText("nope")).toBeUndefined();
		expect(publicAssistantText({ role: "user", content: [textBlock("hi")] })).toBeUndefined();
		expect(publicAssistantText({ role: "assistant", content: "not-an-array" })).toBeUndefined();
		expect(publicAssistantText({ role: "assistant" })).toBeUndefined();
		expect(publicAssistantText({ role: "assistant", content: [] })).toBeUndefined();
		expect(publicAssistantText({ role: "assistant", content: [thinkingBlock("only hidden")] })).toBeUndefined();
		// Malformed blocks are skipped, not guessed from.
		expect(publicAssistantText({ role: "assistant", content: [{ type: "text", text: 42 }, null, textBlock("ok")] })).toBe("ok");
	});

	test("thinking-only and empty text blocks yield no replacement", () => {
		expect(publicAssistantText({ role: "assistant", stopReason: "stop", content: [textBlock("")] })).toBe("");
		expect(normalizeLastText("")).toBeUndefined();
	});
});

describe("normalizeLastText (pure)", () => {
	test("control characters become spaces, whitespace folds, result trims", () => {
		expect(normalizeLastText("  a\u0000\u001fb\u007f\u2028c\n\t d  \r\n e ")).toBe("a b c d e");
	});

	test("cap is applied AFTER normalization and measured in UTF-16 code units", () => {
		const padded = `${" ".repeat(10)}${"a".repeat(600)}${" ".repeat(10)}`;
		const normalized = normalizeLastText(padded)!;
		expect(normalized).toBe("a".repeat(600).slice(0, LAST_TEXT_MAX));
		expect(normalized.length).toBe(LAST_TEXT_MAX);
		// Emoji are surrogate pairs: 300 emoji = 600 UTF-16 units → 256 emoji.
		const emoji = "😀".repeat(300);
		expect(normalizeLastText(emoji)!.length).toBe(LAST_TEXT_MAX);
		expect(normalizeLastText(emoji)).toBe("😀".repeat(256));
	});

	test("empty result is undefined (never replaces an accepted fragment)", () => {
		expect(normalizeLastText("")).toBeUndefined();
		expect(normalizeLastText(" \t\n\u0000 ")).toBeUndefined();
	});
});

describe("validateLastAssistantText (pure)", () => {
	test("accepts a well-formed value", () => {
		expect(validateLastAssistantText({ text: "hi", updatedAt: 123 })).toEqual({ text: "hi", updatedAt: 123 });
	});

	test("rejects malformed values", () => {
		for (const value of [
			undefined,
			null,
			"text",
			[],
			{},
			{ text: "", updatedAt: 1 },
			{ text: "a".repeat(LAST_TEXT_MAX + 1), updatedAt: 1 },
			{ text: "hi" },
			{ text: "hi", updatedAt: -1 },
			{ text: "hi", updatedAt: Number.NaN },
			{ text: 7, updatedAt: 1 },
		]) {
			expect(validateLastAssistantText(value)).toBeUndefined();
		}
	});
});

// --------------------------------------------------- controller integration

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

interface Rt {
	runtime: LocalSubagentRuntime;
	spawned: FakeRpcProcess[];
	tmp: string;
	cleanup(): void;
}

function makeRuntime(parentSession?: string, dir?: string): Rt {
	const harness = createFakeSpawnFactory();
	const tmp = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "lasttext-test-"));
	const runtime = new LocalSubagentRuntime({
		defaultCwd: tmp,
		resultsDir: tmp,
		piCommand: { command: "node", args: ["/fake/pi-cli.js"] },
		bridgePath: "/fake/bridge.ts",
		spawnFn: harness.spawnFn,
		killGraceMs: 50,
		startTimeoutMs: 2000,
		dispatchTimeoutMs: 2000,
		...(parentSession ? { parentSession } : {}),
	});
	return {
		runtime,
		spawned: harness.spawned,
		tmp,
		cleanup() {
			fs.rmSync(tmp, { recursive: true, force: true });
		},
	};
}

async function spawnRunning(rt: Rt): Promise<{ id: string; proc: FakeRpcProcess }> {
	const pending = rt.runtime.spawn({ task: "do things", label: "lab" });
	for (let i = 0; i < 100 && rt.spawned.length === 0; i++) await tick(5);
	const proc = rt.spawned[rt.spawned.length - 1];
	autoAcceptPrompt(proc);
	const snap = await pending;
	expect(snap.state).toBe("running");
	return { id: snap.id, proc };
}

/** Emit a completed assistant message_end with the given content blocks. */
function assistantMessage(proc: FakeRpcProcess, content: unknown[], stopReason = "stop"): void {
	proc.writeToStdout({ type: "message_end", message: { role: "assistant", content, stopReason } });
}

describe("lastAssistantText projection (controller)", () => {
	test("running snapshot carries the last public text before settlement", async () => {
		const rt = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(rt);
			expect(rt.runtime.inspect(id)[0].lastAssistantText).toBeUndefined();
			const before = Date.now();
			assistantMessage(proc, [
				thinkingBlock("private reasoning"),
				textBlock("  Spec and environment are\u0000clear. "),
				toolCallBlock,
			]);
			await tick(10);
			const snap = rt.runtime.inspect(id)[0];
			expect(snap.state).toBe("running");
			expect(snap.lastAssistantText).toEqual({ text: "Spec and environment are clear.", updatedAt: expect.any(Number) });
			expect(snap.lastAssistantText!.updatedAt).toBeGreaterThanOrEqual(before);
			expect(snap.lastAssistantText!.updatedAt).toBeLessThanOrEqual(Date.now());
		} finally {
			await rt.runtime.shutdown();
			rt.cleanup();
		}
	});

	test("a newer completed message replaces the previous fragment", async () => {
		const rt = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(rt);
			assistantMessage(proc, [textBlock("first message")]);
			await tick(5);
			const first = rt.runtime.inspect(id)[0].lastAssistantText!;
			await tick(5);
			assistantMessage(proc, [textBlock("second message")], "toolUse");
			await tick(10);
			const second = rt.runtime.inspect(id)[0].lastAssistantText!;
			expect(second.text).toBe("second message");
			expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
		} finally {
			await rt.runtime.shutdown();
			rt.cleanup();
		}
	});

	test("long text is capped at the wire bound in the live snapshot", async () => {
		const rt = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(rt);
			assistantMessage(proc, [textBlock(`lead ${"x".repeat(800)}`)]);
			await tick(10);
			const snap = rt.runtime.inspect(id)[0].lastAssistantText!;
			expect(snap.text).toBe(`lead ${"x".repeat(800)}`.slice(0, LAST_TEXT_MAX));
			expect(snap.text.length).toBe(LAST_TEXT_MAX);
		} finally {
			await rt.runtime.shutdown();
			rt.cleanup();
		}
	});

	test("error/aborted/deferred and empty messages never replace the fragment", async () => {
		const rt = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(rt);
			assistantMessage(proc, [textBlock("good message")]);
			await tick(10);
			const accepted = rt.runtime.inspect(id)[0].lastAssistantText!;
			for (const stopReason of ["error", "aborted", "deferred"] as const) {
				assistantMessage(proc, [textBlock(`${stopReason} text`)], stopReason);
			}
			assistantMessage(proc, [thinkingBlock("only hidden thinking")]);
			assistantMessage(proc, [textBlock("   \u0000 \n\t ")]);
			await tick(10);
			expect(rt.runtime.inspect(id)[0].lastAssistantText).toEqual(accepted);
		} finally {
			await rt.runtime.shutdown();
			rt.cleanup();
		}
	});

	test("accepted change persists the running marker; terminal result keeps the fragment", async () => {
		const rt = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(rt);
			assistantMessage(proc, [textBlock("working on tests")]);
			await tick(10);
			const marker = loadResult(id, rt.tmp)!;
			expect(marker.status).toBe("running");
			expect(marker.lastAssistantText!.text).toBe("working on tests");

			settleRun(proc, "all done");
			await tick(60);
			expect(rt.runtime.inspect(id)[0].state).toBe("completed");
			const result = await rt.runtime.result(id);
			expect(result!.lastAssistantText!.text).toBe("working on tests");
			const persisted = loadResult(id, rt.tmp)!;
			expect(persisted.status).toBe("completed");
			expect(persisted.lastAssistantText!.text).toBe("working on tests");
		} finally {
			await rt.runtime.shutdown();
			rt.cleanup();
		}
	});

	test("a late message_end after settlement does not mutate the terminal record", async () => {
		const rt = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(rt);
			assistantMessage(proc, [textBlock("final public words")]);
			settleRun(proc, "settled text");
			await tick(60);
			const before = await rt.runtime.result(id);
			const persistedBefore = loadResult(id, rt.tmp)!;

			assistantMessage(proc, [textBlock("late straggler message")]);
			await tick(20);
			const after = await rt.runtime.result(id);
			expect(after!.lastAssistantText).toEqual(before!.lastAssistantText);
			expect(after!.lastAssistantText!.text).toBe("final public words");
			const persistedAfter = loadResult(id, rt.tmp)!;
			expect(persistedAfter.lastAssistantText).toEqual(persistedBefore.lastAssistantText);
			// The snapshot keeps the accepted fragment too (no clearing).
			expect(rt.runtime.inspect(id)[0].lastAssistantText!.text).toBe("final public words");
		} finally {
			await rt.runtime.shutdown();
			rt.cleanup();
		}
	});

	test("agent without any assistant message stays without the field", async () => {
		const rt = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(rt);
			proc.writeToStdout({
				type: "message_end",
				message: { role: "assistant", stopReason: "error", errorMessage: "provider down", content: [textBlock("never")] },
			});
			await tick(10);
			expect(rt.runtime.inspect(id)[0].lastAssistantText).toBeUndefined();
			settleRun(proc, "done anyway");
			await tick(60);
			const result = await rt.runtime.result(id);
			expect(result!.status).toBe("failed"); // error stopReason
			expect("lastAssistantText" in result!).toBe(false);
			expect(loadResult(id, rt.tmp)!.lastAssistantText).toBeUndefined();
		} finally {
			await rt.runtime.shutdown();
			rt.cleanup();
		}
	});

	test("cancelled run keeps the last public fragment", async () => {
		const rt = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(rt);
			assistantMessage(proc, [textBlock("mid-run speech")]);
			await tick(10);
			await rt.runtime.cancel(id);
			await tick(30);
			const result = await rt.runtime.result(id);
			expect(result!.status).toBe("cancelled");
			expect(result!.lastAssistantText!.text).toBe("mid-run speech");
			expect(loadResult(id, rt.tmp)!.lastAssistantText!.text).toBe("mid-run speech");
		} finally {
			await rt.runtime.shutdown();
			rt.cleanup();
		}
	});

	test("lost reconciliation retains the last speech without a live-run promise", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lasttext-lost-"));
		try {
			const harness = createFakeSpawnFactory();
			const mk = () =>
				new LocalSubagentRuntime({
					defaultCwd: tmp,
					resultsDir: tmp,
					piCommand: { command: "node", args: ["/fake/pi-cli.js"] },
					bridgePath: "/fake/bridge.ts",
					spawnFn: harness.spawnFn,
					killGraceMs: 50,
					startTimeoutMs: 2000,
					dispatchTimeoutMs: 2000,
					parentSession: "session-lost",
				});
			const first = mk();
			const pending = first.spawn({ task: "t", label: "lab" });
			for (let i = 0; i < 100 && harness.spawned.length === 0; i++) await tick(5);
			const proc = harness.spawned[harness.spawned.length - 1];
			autoAcceptPrompt(proc);
			const snap = await pending;
			assistantMessage(proc, [textBlock("last words before the crash")]);
			await tick(10);
			expect(loadResult(snap.id, tmp)!.lastAssistantText!.text).toBe("last words before the crash");

			// Parent restart: reconciliation finalizes the running marker as
			// failed; the accepted speech survives on the record.
			const second = mk();
			const finalized = loadResult(snap.id, tmp)!;
			expect(finalized.status).toBe("failed");
			expect(finalized.failureReason).toBe("child lost across parent restart");
			expect(finalized.lastAssistantText!.text).toBe("last words before the crash");
			await second.shutdown();
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("follow-up rerun accepts fresh speech after terminal reuse", async () => {
		const rt = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(rt);
			assistantMessage(proc, [textBlock("first run speech")]);
			settleRun(proc, "done");
			await tick(60);
			expect((await rt.runtime.result(id))!.status).toBe("completed");

			await rt.runtime.followUp(id, "more work");
			proc.writeToStdout({ type: "agent_start" });
			await tick(10);
			expect(rt.runtime.inspect(id)[0].state).toBe("running");
			assistantMessage(proc, [textBlock("second run speech")]);
			await tick(10);
			expect(rt.runtime.inspect(id)[0].lastAssistantText!.text).toBe("second run speech");
		} finally {
			await rt.runtime.shutdown();
			rt.cleanup();
		}
	});
});

describe("lastAssistantText boundary on persisted result reads", () => {
	/** Write a foreign/legacy persisted record straight to disk, as a
	 * previous session (or a corrupting crash) would have left it. */
	function writeRecord(dir: string, record: Record<string, unknown>): void {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record), "utf8");
	}

	const terminalRecord = (id: string, extra: Record<string, unknown> = {}) => ({
		id,
		label: "lab",
		task: "t",
		cwd: "/tmp/w",
		status: "completed",
		finalText: "old final text",
		summary: "old final text",
		startedAt: 1,
		endedAt: 2,
		...extra,
	});

	test("valid bounded fragment survives the history read after a restart", async () => {
		const rt = makeRuntime();
		try {
			writeRecord(rt.tmp, terminalRecord("sa-keep", { lastAssistantText: { text: "kept speech", updatedAt: 1717000000000 } }));
			const result = await rt.runtime.result("sa-keep");
			expect(result).not.toBeNull();
			expect(result!.status).toBe("completed");
			expect(result!.finalText).toBe("old final text");
			expect(result!.lastAssistantText).toEqual({ text: "kept speech", updatedAt: 1717000000000 });
		} finally {
			await rt.runtime.shutdown();
			rt.cleanup();
		}
	});

	test("malformed field is dropped, other result facts kept, old records not rewritten", async () => {
		const malformed: Record<string, unknown> = {
			oversize: { text: "x".repeat(LAST_TEXT_MAX + 1), updatedAt: 1 },
			nonStringText: { text: 7, updatedAt: 1 },
			emptyText: { text: "", updatedAt: 1 },
			stringTimestamp: { text: "hi", updatedAt: "soon" },
			nullTimestamp: { text: "hi", updatedAt: null },
			negativeTimestamp: { text: "hi", updatedAt: -1 },
			arrayValue: ["not", "an", "object"],
			scalarValue: "junk",
		};
		const rt = makeRuntime();
		try {
			for (const [name, value] of Object.entries(malformed)) {
				const id = `sa-bad-${name}`;
				writeRecord(rt.tmp, terminalRecord(id, { lastAssistantText: value }));
				const result = await rt.runtime.result(id);
				expect(result!.status).toBe("completed");
				expect(result!.finalText).toBe("old final text");
				expect(result!.summary).toBe("old final text");
				expect("lastAssistantText" in result!).toBe(false);
				// Tolerance is read-time only: the old record on disk is preserved.
				const onDisk = JSON.parse(fs.readFileSync(path.join(rt.tmp, `${id}.json`), "utf8"));
				expect(onDisk.lastAssistantText).toEqual(value);
			}
		} finally {
			await rt.runtime.shutdown();
			rt.cleanup();
		}
	});

	test("plain terminal record without the field reads unchanged after a restart", async () => {
		const rt = makeRuntime();
		try {
			writeRecord(rt.tmp, terminalRecord("sa-plain"));
			const result = await rt.runtime.result("sa-plain");
			expect(result).toMatchObject({ id: "sa-plain", status: "completed", finalText: "old final text" });
			expect("lastAssistantText" in result!).toBe(false);
		} finally {
			await rt.runtime.shutdown();
			rt.cleanup();
		}
	});

	test("running marker is never a result; lost reconciliation drops the malformed field", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lasttext-boundary-"));
		// Foreign running marker: untouched by reconciliation, and a spawn
			// marker must never surface as an outcome.
			writeRecord(tmp, {
				id: "sa-foreign",
				label: "lab",
				task: "t",
				cwd: "/tmp/w",
				status: "running",
				startedAt: 1,
				parentSession: "other-session",
				lastAssistantText: { text: "x".repeat(LAST_TEXT_MAX + 1), updatedAt: 1 },
			});
			// Own running marker: finalized as lost by the constructor, malformed
			// optional field dropped from the finalized record.
			writeRecord(tmp, {
				id: "sa-own",
				label: "lab",
				task: "t",
				cwd: "/tmp/w",
				status: "running",
				startedAt: 1,
				parentSession: "session-boundary",
				lastAssistantText: { text: 7, updatedAt: 1 },
			});
		// The runtime's startup reconciliation finalizes this marker at
		// construction, so both markers must be on disk before it is created.
		const rt = makeRuntime("session-boundary", tmp);
		try {
			expect(await rt.runtime.result("sa-foreign")).toBeNull();
			const lost = await rt.runtime.result("sa-own");
			expect(lost!.status).toBe("failed");
			expect(lost!.failureReason).toBe("child lost across parent restart");
			expect("lastAssistantText" in lost!).toBe(false);
		} finally {
			await rt.runtime.shutdown();
			rt.cleanup();
		}
	});

	test("terminal fragment from a real run survives a full controller restart", async () => {
		const rt = makeRuntime();
		let id = "";
		try {
			const { id: spawnedId, proc } = await spawnRunning(rt);
			id = spawnedId;
			assistantMessage(proc, [textBlock("words before the end")]);
			await tick(10);
			settleRun(proc, "all done");
			await tick(60);
			expect((await rt.runtime.result(id))!.lastAssistantText!.text).toBe("words before the end");
		} finally {
			await rt.runtime.shutdown();
		}
		const second = makeRuntime(undefined, rt.tmp);
		try {
			const result = await second.runtime.result(id);
			expect(result!.status).toBe("completed");
			expect(result!.lastAssistantText!.text).toBe("words before the end");
		} finally {
			await second.runtime.shutdown();
			rt.cleanup();
		}
	});
});

describe("lastAssistantText projection (narrow inspection seam)", () => {
	test("agentDetailView projects the snapshot fragment for plain and workspace views", () => {
		const base: AgentSnapshot = {
			id: "sa-9",
			label: "owner",
			state: "running",
			task: "t",
			cwd: "/tmp/w",
			alive: true,
			startedAt: 1,
			lastActivityAt: 2,
			elapsedMs: 3,
		};
		const withText = { ...base, lastAssistantText: { text: "running the checks now", updatedAt: 42 } };
		expect(agentDetailView(withText)).toMatchObject({ lastAssistantText: { text: "running the checks now", updatedAt: 42 } });
		expect(
			agentDetailView(withText, { state: "running", workspace: "/tmp/ws", deadlineMsLeft: 10 }),
		).toMatchObject({
			lastAssistantText: { text: "running the checks now", updatedAt: 42 },
			run: { workspace: "/tmp/ws", state: "running" },
		});
		// Absent field stays absent: old consumers see no change.
		expect(agentDetailView(base).lastAssistantText).toBeUndefined();
	});
});
