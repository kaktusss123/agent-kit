import { describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import { phasesWith } from "./test-fixtures.ts";
import {
	type TodoPhase,
	applyTodoOp,
	applyParams,
	clonePhases,
	formatErrorResult,
	formatMutationSummary,
	formatSummary,
	incompleteByPhase,
	inferTodoOp,
	isClosedTodo,
	latestPhasesFromEntries,
	nextActionableTask,
	normalizeInProgressTask,
	phaseRomanNumeral,
	phasesToMarkdown,
	resolveTodoParams,
	selectCollapsedTodos,
} from "./core.ts";

describe("todo ops", () => {
	test("init creates pending phases and auto-promotes the earliest task", () => {
		const { phases, errors } = applyParams([], {
			op: "init",
			list: [
				{ phase: "Foundation", items: ["Scaffold crate", "Wire workspace"] },
				{ phase: "Verify", items: ["Run tests"] },
			],
		});
		expect(errors).toEqual([]);
		expect(phases[0]!.tasks[0]).toEqual({ content: "Scaffold crate", status: "in_progress" });
		expect(phases[0]!.tasks[1]!.status).toBe("pending");
		expect(phases[1]!.tasks[0]!.status).toBe("pending");
	});

	test("flat init without list synthesizes a single default phase", () => {
		const { phases, errors } = applyParams([], { op: "init", items: ["One", "Two"] });
		expect(errors).toEqual([]);
		expect(phases).toHaveLength(1);
		expect(phases[0]!.name).toBe("Tasks");
		expect(phases[0]!.tasks).toHaveLength(2);
	});

	test("duplicate task or phase names are rejected and the batch is discarded", () => {
		const current = phasesWith({ name: "P", tasks: [["Existing", "completed"]] });
		const dupTask = applyParams(current, {
			op: "init",
			list: [{ phase: "A", items: ["New"] }, { phase: "B", items: ["New"] }],
		});
		expect(dupTask.errors.some(e => e.includes('Duplicate task "New"'))).toBe(true);
		const dupPhase = applyParams(current, {
			op: "init",
			list: [{ phase: "A", items: ["X"] }, { phase: "A", items: ["Y"] }],
		});
		expect(dupPhase.errors.some(e => e.includes('Duplicate phase "A"'))).toBe(true);
	});

	test("failed batch leaves state untouched", () => {
		const current = phasesWith({ name: "P", tasks: [["Existing", "completed"]] });
		// append validates against existing state; the duplicate fails the whole op
		const { phases, errors } = applyTodoOp(current, { op: "append", phase: "P", items: ["New", "Existing"] });
		expect(errors.some(e => e.includes("Task \"Existing\" already exists"))).toBe(true);
		expect(phases).toEqual(current);
		// init replaces the whole list, so colliding with old state is legal
		const fresh = applyTodoOp(current, { op: "init", list: [{ phase: "N", items: ["Existing"] }] });
		expect(fresh.errors).toEqual([]);
		expect(fresh.phases).toHaveLength(1);
	});

	test("done flips a task and promotes the next pending one", () => {
		const current = phasesWith({ name: "P", tasks: [["A", "in_progress"], ["B", "pending"], ["C", "pending"]] });
		const { phases, errors } = applyParams(current, { op: "done", task: "A" });
		expect(errors).toEqual([]);
		expect(phases[0]!.tasks[0]!.status).toBe("completed");
		expect(phases[0]!.tasks[1]!.status).toBe("in_progress");
	});

	test("done on a phase completes the whole phase", () => {
		const current = phasesWith(
			{ name: "P1", tasks: [["A", "in_progress"], ["B", "pending"]] },
			{ name: "P2", tasks: [["C", "pending"]] },
		);
		const { phases } = applyParams(current, { op: "done", phase: "P1" });
		expect(phases[0]!.tasks.every(isClosedTodo)).toBe(true);
		// pointer moves to the next open phase
		expect(phases[1]!.tasks[0]!.status).toBe("in_progress");
	});

	test("start moves the in_progress pointer", () => {
		const current = phasesWith({ name: "P", tasks: [["A", "in_progress"], ["B", "pending"]] });
		const { phases } = applyParams(current, { op: "start", task: "B" });
		expect(phases[0]!.tasks[0]!.status).toBe("pending");
		expect(phases[0]!.tasks[1]!.status).toBe("in_progress");
	});

	test("unknown task errors teach content addressing, not IDs", () => {
		const current = phasesWith({ name: "P", tasks: [["A", "pending"]] });
		const byId = applyParams(current, { op: "done", task: "task-1" });
		expect(byId.errors[0]).toContain("referenced by content, not by IDs");
		const byText = applyParams(current, { op: "done", task: "Nope" });
		expect(byText.errors[0]).toContain('Task "Nope" not found');
	});

	test("block keeps a task from auto-promoting and carries the reason; unblock restores it", () => {
		const current = phasesWith({ name: "P", tasks: [["A", "in_progress"], ["B", "pending"]] });
		const blocked = applyParams(current, { op: "block", task: "A", reason: "waiting on\ndecision" });
		expect(blocked.phases[0]!.tasks[0]).toEqual({ content: "A", status: "blocked", blocker: "waiting on decision" });
		// blocked task never auto-promotes: pointer moved to B
		expect(blocked.phases[0]!.tasks[1]!.status).toBe("in_progress");
		const unblocked = applyParams(blocked.phases, { op: "unblock", task: "A" });
		expect(unblocked.phases[0]!.tasks[0]!.status).toBe("pending");
		expect(unblocked.phases[0]!.tasks[0]!.blocker).toBeUndefined();
	});

	test("block requires a target", () => {
		const { errors } = applyParams(phasesWith({ name: "P", tasks: [["A", "pending"]] }), { op: "block" });
		expect(errors[0]).toContain("requires a task or phase target");
	});

	test("drop marks abandoned; rm removes task, phase, or everything", () => {
		const current = phasesWith({ name: "P", tasks: [["A", "in_progress"], ["B", "pending"]] });
		const dropped = applyParams(current, { op: "drop", task: "B" });
		expect(dropped.phases[0]!.tasks[1]!.status).toBe("abandoned");
		const rmTask = applyParams(current, { op: "rm", task: "A" });
		expect(rmTask.phases[0]!.tasks.map(t => t.content)).toEqual(["B"]);
		const rmAll = applyParams(current, { op: "rm" });
		expect(rmAll.phases[0]!.tasks).toEqual([]);
	});

	test("append lazily creates a phase and rejects duplicates in the same batch", () => {
		const { phases, errors } = applyParams([], { op: "append", phase: "Later", items: ["X"] });
		expect(errors).toEqual([]);
		expect(phases[0]!.name).toBe("Later");
		const dup = applyParams(phases, { op: "append", phase: "Later", items: ["X", "X"] });
		expect(dup.errors.length).toBe(2);
		expect(dup.phases[0]!.tasks).toHaveLength(1); // nothing half-applied
	});

	test("view echoes without mutating", () => {
		const current = phasesWith({ name: "P", tasks: [["A", "in_progress"]] });
		const { phases: after, errors } = applyParams(current, { op: "view" });
		expect(errors).toEqual([]);
		expect(after).toEqual(current);
	});
});

describe("op inference", () => {
	test("missing op is repaired from unambiguous shapes", () => {
		expect(inferTodoOp({ list: [{ phase: "P", items: ["A"] }] }, false)).toBe("init");
		expect(inferTodoOp({ items: ["A"], phase: "P" }, true)).toBe("append");
		expect(inferTodoOp({ items: ["A"] }, false)).toBe("init");
		expect(inferTodoOp({ items: ["A"] }, true)).toBeUndefined();
		expect(inferTodoOp({ task: "A" }, true)).toBeUndefined();
	});

	test("resolveTodoParams repairs missing op and rejects ambiguous payloads", () => {
		expect(resolveTodoParams({ list: [{ phase: "P", items: ["A"] }] }, false)).toEqual({
			list: [{ phase: "P", items: ["A"] }],
			op: "init",
		});
		const ambiguous = resolveTodoParams({ task: "A" }, true);
		expect(typeof ambiguous).toBe("string");
	});

	test("missing op with existing phases and bare items is an error, not a silent overwrite", () => {
		const resolved = resolveTodoParams({ items: ["A"] }, true);
		expect(typeof resolved).toBe("string");
	});
});

describe("collapsed viewport", () => {
	test("closed lead is additive; active leads open work; summary counts hidden", () => {
		const tasks = phasesWith({
			name: "P",
			tasks: [
				["done1", "completed"],
				["p1", "pending"],
				["active", "in_progress"],
				["p2", "pending"],
				["p3", "pending"],
				["p4", "pending"],
				["p5", "pending"],
			],
		})[0]!.tasks;
		const sel = selectCollapsedTodos(tasks, 4);
		// lead closed task + 4 open rows (active first)
		expect(sel.items[0]!.content).toBe("done1");
		expect(sel.items[1]!.content).toBe("active");
		expect(sel.items).toHaveLength(5);
		expect(sel.summary).toContain("more");
	});

	test("fully closed phase falls back to closed tasks", () => {
		const tasks = phasesWith({ name: "P", tasks: [["a", "completed"], ["b", "completed"]] })[0]!.tasks;
		const sel = selectCollapsedTodos(tasks, 4);
		expect(sel.items).toHaveLength(2);
		expect(sel.summary).toBe("");
	});
});

describe("summary text", () => {
	test("reports counts, open items, and the active phase", () => {
		const current = phasesWith(
			{ name: "P1", tasks: [["A", "completed"], ["B", "in_progress"]] },
			{ name: "P2", tasks: [["C", "pending"]] },
		);
		const text = formatSummary(current, []);
		expect(text).toContain("Overall: 1/3 done, 2 open");
		expect(text).toContain('Active phase 1/2 "P1" (1/2)');
		expect(text).toContain("- B [in_progress] (P1)");
	});

	test("worked-ahead case explains the backward pointer", () => {
		const current = phasesWith(
			{ name: "P1", tasks: [["A", "in_progress"]] },
			{ name: "P2", tasks: [["C", "completed"]] },
		);
		const text = formatSummary(current, []);
		expect(text).toContain("earliest phase with open tasks");
	});

	test("cleared list says so; empty view says empty", () => {
		expect(formatSummary([], [])).toBe("Todo list cleared.");
		expect(formatSummary([], [], true)).toBe("Todo list is empty.");
	});
});

describe("markdown", () => {
	test("renders checklist with status markers and blocker comments", () => {
		const current = phasesWith(
			{ name: "P1", tasks: [["A", "completed"], ["B", "in_progress"]] },
			{ name: "P2", tasks: [["C", "blocked"]] },
		);
		current[1]!.tasks[0]!.blocker = "external";
		const md = phasesToMarkdown(current);
		expect(md).toContain("# P1\n- [x] A\n- [/] B");
		expect(md).toContain("# P2\n- [!] C <!-- blocker: external -->");
	});
});

describe("rehydration", () => {
	test("latest successful todo tool result wins; errors and other tools are skipped", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "hi" } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					isError: true,
					details: { phases: phasesWith({ name: "Bad", tasks: [["bad", "pending"]] }) },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: { phases: phasesWith({ name: "Old", tasks: [["old", "completed"]] }) },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "bash",
					details: { phases: phasesWith({ name: "Other", tasks: [["x", "pending"]] }) },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: { phases: phasesWith({ name: "New", tasks: [["new", "in_progress"]] }) },
				},
			},
		];
		const restored = latestPhasesFromEntries(entries);
		expect(restored[0]!.name).toBe("New");
		// defensive clone: mutating the result must not corrupt the source entry
		restored[0]!.tasks[0]!.status = "completed";
		expect((entries[4] as { message: { details: { phases: Array<{ status: string }> } } }).message.details.phases[0].tasks[0].status).toBe("in_progress");
	});

	test("empty or absent branches yield an empty list", () => {
		expect(latestPhasesFromEntries([])).toEqual([]);
		expect(latestPhasesFromEntries([{ type: "message", message: { role: "user" } }])).toEqual([]);
	});
});

describe("misc", () => {
	test("normalizeInProgressTask demotes extra pointers and promotes when none", () => {
		const two = phasesWith({ name: "P", tasks: [["A", "in_progress"], ["B", "in_progress"]] });
		normalizeInProgressTask(two);
		expect(two[0]!.tasks[0]!.status).toBe("in_progress");
		expect(two[0]!.tasks[1]!.status).toBe("pending");
		const none = phasesWith({ name: "P", tasks: [["A", "pending"], ["B", "pending"]] });
		normalizeInProgressTask(none);
		expect(none[0]!.tasks[0]!.status).toBe("in_progress");
	});

	test("nextActionableTask prefers in_progress over first pending", () => {
		const current = phasesWith({ name: "P", tasks: [["A", "pending"], ["B", "in_progress"]] });
		expect(nextActionableTask(current)?.content).toBe("B");
	});

	test("roman numerals for display-only phase numbering", () => {
		expect(phaseRomanNumeral(1)).toBe("I");
		expect(phaseRomanNumeral(4)).toBe("IV");
		expect(phaseRomanNumeral(9)).toBe("IX");
		expect(phaseRomanNumeral(0)).toBe("");
	});

	test("clonePhases produces independent copies", () => {
		const current = phasesWith({ name: "P", tasks: [["A", "pending"]] });
		const copy = clonePhases(current);
		copy[0]!.tasks[0]!.status = "completed";
		expect(current[0]!.tasks[0]!.status).toBe("pending");
	});

	test("incompleteByPhase splits open work by phase and skips closed", () => {
		const current = phasesWith(
			{ name: "P1", tasks: [["A", "completed"], ["B", "pending"]] },
			{ name: "P2", tasks: [["C", "completed"]] },
		);
		const incomplete = incompleteByPhase(current);
		expect(incomplete).toHaveLength(1);
		expect(incomplete[0]).toEqual({ name: "P1", tasks: [{ content: "B", status: "pending" }] });
	});
});

describe("terminal state protection", () => {
	test("start on completed/abandoned is rejected", () => {
		const current = phasesWith({
			name: "P",
			tasks: [["Done", "completed"], ["Dropped", "abandoned"]],
		});
		const started = applyTodoOp(current, { op: "start", task: "Done" });
		expect(started.errors[0]).toContain('Cannot start "Done": task is completed (terminal)');
		expect(started.phases).toEqual(current);
		const startedDropped = applyTodoOp(current, { op: "start", task: "Dropped" });
		expect(startedDropped.errors[0]).toContain("task is abandoned (terminal)");
		expect(startedDropped.phases).toEqual(current);
	});

	test("start on blocked is rejected and points at unblock", () => {
		const current = phasesWith({ name: "P", tasks: [["Waiting", "blocked"]] });
		const { errors, phases } = applyTodoOp(current, { op: "start", task: "Waiting" });
		expect(errors[0]).toContain("unblock");
		expect(phases[0]!.tasks[0]!.status).toBe("blocked");
	});

	test("start on in_progress is an idempotent no-op", () => {
		const current = phasesWith({ name: "P", tasks: [["A", "in_progress"], ["B", "pending"]] });
		const { phases, errors, moved } = applyTodoOp(current, { op: "start", task: "A" });
		expect(errors).toEqual([]);
		expect(moved).toBe(0);
		expect(phases[0]!.tasks.map(t => t.status)).toEqual(["in_progress", "pending"]);
	});

	test("done on completed is an idempotent no-op; done on abandoned is rejected", () => {
		const current = phasesWith({ name: "P", tasks: [["Done", "completed"], ["Dropped", "abandoned"]] });
		const redone = applyTodoOp(current, { op: "done", task: "Done" });
		expect(redone.errors).toEqual([]);
		expect(redone.moved).toBe(0);
		expect(redone.phases).toEqual(current);
		const resurrected = applyTodoOp(current, { op: "done", task: "Dropped" });
		expect(resurrected.errors[0]).toContain('Cannot done "Dropped": task is already abandoned (terminal)');
		expect(resurrected.phases).toEqual(current);
	});

	test("drop on abandoned is an idempotent no-op; drop on completed is rejected", () => {
		const current = phasesWith({ name: "P", tasks: [["Done", "completed"], ["Dropped", "abandoned"]] });
		const redropped = applyTodoOp(current, { op: "drop", task: "Dropped" });
		expect(redropped.errors).toEqual([]);
		expect(redropped.moved).toBe(0);
		expect(redropped.phases).toEqual(current);
		const flipped = applyTodoOp(current, { op: "drop", task: "Done" });
		expect(flipped.errors[0]).toContain('Cannot drop "Done": task is already completed (terminal)');
		expect(flipped.phases).toEqual(current);
	});

	test("done on a blocked task is allowed (a resolved wait is a legitimate close)", () => {
		const current = phasesWith({ name: "P", tasks: [["A", "in_progress"], ["Waiting", "blocked"]] });
		const { phases, errors } = applyTodoOp(current, { op: "done", task: "Waiting" });
		expect(errors).toEqual([]);
		expect(phases[0]!.tasks[1]!.status).toBe("completed");
		expect(phases[0]!.tasks[0]!.status).toBe("in_progress"); // untouched
	});

	test("phase-wide done settles open work and skips settled tasks without error", () => {
		const current = phasesWith({
			name: "P",
			tasks: [
				["AlreadyDone", "completed"],
				["DeliberatelyDropped", "abandoned"],
				["Active", "in_progress"],
				["Queued", "pending"],
				["Waiting", "blocked"],
			],
		});
		const { phases, errors } = applyTodoOp(current, { op: "done", phase: "P" });
		expect(errors).toEqual([]);
		const byContent = new Map(phases[0]!.tasks.map(t => [t.content, t.status]));
		expect(byContent.get("AlreadyDone")).toBe("completed");
		expect(byContent.get("DeliberatelyDropped")).toBe("abandoned");
		expect(byContent.get("Active")).toBe("completed");
		expect(byContent.get("Queued")).toBe("completed");
		expect(byContent.get("Waiting")).toBe("completed");
	});

	test("phase-wide drop abandons open work and never flips completed tasks", () => {
		const current = phasesWith({
			name: "P",
			tasks: [
				["AlreadyDone", "completed"],
				["Active", "in_progress"],
				["Queued", "pending"],
			],
		});
		const { phases, errors } = applyTodoOp(current, { op: "drop", phase: "P" });
		expect(errors).toEqual([]);
		const byContent = new Map(phases[0]!.tasks.map(t => [t.content, t.status]));
		expect(byContent.get("AlreadyDone")).toBe("completed");
		expect(byContent.get("Active")).toBe("abandoned");
		expect(byContent.get("Queued")).toBe("abandoned");
	});
});

describe("compact mutation result", () => {
	test("done reports the change, progress, and next task — not the whole tree", () => {
		const current = phasesWith({
			name: "P",
			tasks: [["Implement parser", "in_progress"], ["Add parser tests", "pending"], ["Ship", "pending"]],
		});
		const { phases, moved } = applyTodoOp(current, { op: "done", task: "Implement parser" });
		const text = formatMutationSummary({ op: "done", task: "Implement parser" }, phases, moved);
		expect(text).toBe('Completed "Implement parser". 1/3 done. Next: "Add parser tests".');
		expect(text).not.toContain("Ship"); // sibling tasks stay out of model output
		expect(text).not.toContain("[ ]"); // no checklist dump
	});

	test("start names the started task and progress, without echoing the list", () => {
		const current = phasesWith({ name: "P", tasks: [["A", "pending"], ["B", "pending"]] });
		const { phases, moved } = applyTodoOp(current, { op: "start", task: "A" });
		expect(formatMutationSummary({ op: "start", task: "A" }, phases, moved)).toBe('Started "A". 0/2 done.');
	});

	test("init reports shape and the promoted task", () => {
		const { phases, moved } = applyTodoOp([], {
			op: "init",
			list: [{ phase: "P1", items: ["One"] }, { phase: "P2", items: ["Two", "Three"] }],
		});
		expect(formatMutationSummary({ op: "init" }, phases, moved)).toBe(
			'Todo list initialized: 3 task(s) in 2 phase(s). Next: "One".',
		);
	});

	test("blocked-only remainder tells the model nothing is actionable", () => {
		const current = phasesWith({ name: "P", tasks: [["A", "in_progress"], ["Waiting", "blocked"]] });
		const blocked = applyTodoOp(current, { op: "block", task: "Waiting", reason: "CI down" });
		expect(formatMutationSummary({ op: "block", task: "Waiting", reason: "CI down" }, blocked.phases, blocked.moved)).toBe(
			'Blocked "Waiting" (CI down). 0/2 done, 1 blocked. Next: "A".',
		);
		const doneA = applyTodoOp(blocked.phases, { op: "done", task: "A" });
		expect(formatMutationSummary({ op: "done", task: "A" }, doneA.phases, doneA.moved)).toBe(
			'Completed "A". 1/2 done, 1 blocked. Nothing actionable — unblock or drop blocked tasks.',
		);
	});

	test("final task completion reports completion without a next pointer", () => {
		const current = phasesWith({ name: "P", tasks: [["A", "in_progress"], ["B", "completed"]] });
		const { phases, moved } = applyTodoOp(current, { op: "done", task: "A" });
		expect(formatMutationSummary({ op: "done", task: "A" }, phases, moved)).toBe('Completed "A". 2/2 done. All done.');
	});

	test("phase-wide done reports how many tasks the sweep settled", () => {
		const current = phasesWith({
			name: "P",
			tasks: [
				["AlreadyDone", "completed"],
				["Active", "in_progress"],
				["Queued", "pending"],
			],
		});
		const { phases, moved } = applyTodoOp(current, { op: "done", phase: "P" });
		expect(moved).toBe(2);
		expect(formatMutationSummary({ op: "done", phase: "P" }, phases, moved)).toBe(
			'Completed phase "P" (2 task(s)). 3/3 done. All done.',
		);
	});

	test("rm, append, and unblock stay compact", () => {
		const current = phasesWith({ name: "P", tasks: [["A", "in_progress"], ["B", "pending"]] });
		const removed = applyTodoOp(current, { op: "rm", task: "B" });
		expect(formatMutationSummary({ op: "rm", task: "B" }, removed.phases, removed.moved)).toBe(
			'Removed "B". 0/1 done. Next: "A".',
		);
		const appended = applyTodoOp(removed.phases, { op: "append", phase: "P", items: ["C", "D"] });
		expect(formatMutationSummary({ op: "append", phase: "P", items: ["C", "D"] }, appended.phases, appended.moved)).toBe(
			'Added 2 task(s) to "P". 0/3 done. Next: "A".',
		);
		const unblocked = applyTodoOp(current, { op: "unblock", task: "A" });
		expect(formatMutationSummary({ op: "unblock", task: "A" }, unblocked.phases, unblocked.moved)).toBe(
			'Unblocked "A". 0/2 done. Next: "A".',
		);
	});

	test("cleared list and failed batches have fixed informative shapes", () => {
		const cleared = applyTodoOp(current1(), { op: "rm" });
		expect(formatMutationSummary({ op: "rm" }, cleared.phases, cleared.moved)).toBe("Todo list cleared.");
		expect(formatErrorResult(['Task "X" not found'])).toBe("Errors: Task \"X\" not found\nTodo state unchanged.");
	});

	function current1() {
		return phasesWith({ name: "P", tasks: [["A", "in_progress"]] });
	}
});
