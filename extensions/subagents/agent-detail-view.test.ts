import { describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerExtension, { agentDetailView } from "./index.ts";
import type { AgentSnapshot } from "./types.ts";
import type { WorkspaceRunView } from "./workspace-runs.ts";
import { publishSubagentStateSource, type ReadOnlyStateRegistry } from "./read-only-state.ts";

function makePi() {
	const messages: Array<Record<string, unknown>> = [];
	const pi = {
		registerTool: () => {},
		registerCommand: () => {},
		sendMessage: (message: Record<string, unknown>) => { messages.push(message); },
		getThinkingLevel: () => "low",
		on: () => () => {},
	} as unknown as ExtensionAPI;
	return { pi, messages };
}

describe("agentDetailView (shared with subagent op=status)", () => {
	const snap = (over: Partial<AgentSnapshot> = {}): AgentSnapshot => ({
		id: "sa-1", label: "worker", state: "running", task: "x".repeat(300), cwd: "/tmp/w",
		alive: true, pid: 4242, startedAt: 1, lastActivityAt: 2, elapsedMs: 3, ...over,
	});

	test("without a run view: the clipped snapshot only", () => {
		const detail = agentDetailView(snap()) as Record<string, unknown>;
		expect(detail.task).toBe(`${"x".repeat(200)}…`);
		expect(detail.run).toBeUndefined();
		expect(detail.pid).toBe(4242);
	});

	test("non-terminal workspace view: compact run view, no terminal status", () => {
		const view: WorkspaceRunView = {
			state: "running", workspace: "/tmp/ws", deadlineMsLeft: 12345, ladder: { step: 1, max: 3 },
		};
		const detail = agentDetailView(snap(), view) as Record<string, unknown>;
		expect(detail.run).toEqual({
			workspace: "/tmp/ws", state: "running", deadlineMsLeft: 12345, ladder: { step: 1, max: 3 },
		});
	});

	test("terminal workspace view: run folds to the terminal status, ladder dropped", () => {
		const view: WorkspaceRunView = {
			state: "completed", workspace: "/tmp/ws", deadlineMsLeft: 0,
			terminal: { status: "done" } as WorkspaceRunView["terminal"],
		};
		const detail = agentDetailView(snap({ state: "completed", alive: false }), view) as Record<string, unknown>;
		expect(detail.run).toEqual({
			workspace: "/tmp/ws", state: "completed", status: "done", deadlineMsLeft: 0, terminal: { status: "done" },
		});
	});

	for (const status of ["done", "partial", "blocked"] as const) {
		test(`projects ${status} terminal facts without leaking full outcomes`, () => {
			const view: WorkspaceRunView = {
				state: "settled", workspace: "/tmp/ws", deadlineMsLeft: 0,
				terminal: {
					status, dispatched: true, workspace: "/tmp/ws", reason: "runtime reason",
					last_output: "private full output", child_may_have_mutated_repo: true,
					git_facts: { branch: "feat/test", headSha: "abc", dirty: { staged: [], unstaged: [] } },
					result: {
						status: "blocked", summary: "Product summary", changed_scope: ["private path"],
						verification: [], gaps: ["private gap"], contract_conflicts: ["private conflict"],
					},
				},
			};
			const before = structuredClone(view);
			const detail = agentDetailView(snap({ state: "completed", alive: false }), view);
			expect(detail.state).toBe("completed");
			expect(detail.run).toEqual({
				workspace: "/tmp/ws", state: "settled", status, deadlineMsLeft: 0,
				terminal: { status, reason: "runtime reason", result: { status: "blocked", summary: "Product summary" } },
			});
			expect(view).toEqual(before);
		});
	}

	test("expired deadline and recovery ladder do not imply a terminal outcome", () => {
		const detail = agentDetailView(snap(), {
			state: "terminating", workspace: "/tmp/ws", deadlineMsLeft: 0, ladder: { step: 3, max: 3 },
		});
		expect(detail.run).toEqual({
			workspace: "/tmp/ws", state: "terminating", deadlineMsLeft: 0, ladder: { step: 3, max: 3 },
		});
	});

	test("public source reads the shared projection without changing state or delivering messages", () => {
		const scope = globalThis as { [key: symbol]: ReadOnlyStateRegistry | undefined };
		const key = Symbol.for("agentkit.read-only-state.v1");
		const previous = scope[key];
		const previousSource = previous?.subagents;
		const { pi, messages } = makePi();
		registerExtension(pi);
		const snapshots = [snap({ id: "plain" }), snap({ id: "owner", state: "completed", alive: false })];
		const view: WorkspaceRunView = {
			state: "settled", workspace: "/tmp/ws", deadlineMsLeft: 0,
			terminal: {
				status: "done", dispatched: true, workspace: "/tmp/ws",
				result: { status: "partial", summary: "Remaining work", changed_scope: [], verification: [], gaps: [] },
			},
		};
		const before = structuredClone({ snapshots, view });
		let reads = 0;
		publishSubagentStateSource(() => {
			reads++;
			return snapshots.map((snapshot) => agentDetailView(snapshot, snapshot.id === "owner" ? view : undefined));
		});
		try {
			for (const _ of ["first", "second"]) {
				expect(scope[key]!.subagents!.read()).toEqual({
					status: "ok", activity: "active", agents: [
						{ ...snapshots[0], task: `${"x".repeat(200)}…` },
						{ ...snapshots[1], task: `${"x".repeat(200)}…`, run: {
							workspace: "/tmp/ws", state: "settled", status: "done", deadlineMsLeft: 0,
							terminal: { status: "done", result: { status: "partial", summary: "Remaining work" } },
						} },
					],
				});
			}
			expect(reads).toBe(2);
			expect({ snapshots, view }).toEqual(before);
			expect(messages).toEqual([]);
		} finally {
			if (previous) { previous.subagents = previousSource; scope[key] = previous; }
			else delete scope[key];
		}
	});
});
