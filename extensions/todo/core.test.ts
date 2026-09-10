import { describe, expect, test } from "bun:test";
import { phasesWith } from "./test-fixtures";
import {
	type TodoPhase,
	applyTodoOp,
	applyParams,
	clonePhases,
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
} from "./core";

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
