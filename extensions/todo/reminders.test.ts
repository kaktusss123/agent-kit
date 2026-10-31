import { describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import { phasesWith } from "./test-fixtures.ts";
import {
	DEFAULT_REMINDER_CONFIG,
	type ReminderEngineConfig,
	TodoReminderEngine,
	allTodosClosed,
	buildStopReminderText,
	isAwaitingUserAnswer,
} from "./reminders.ts";

function makeConfig(overrides: Partial<ReminderEngineConfig> = {}): ReminderEngineConfig {
	return {
		...DEFAULT_REMINDER_CONFIG,
		mutatingTools: new Set(["bash", "edit", "write"]),
		...overrides,
	};
}

describe("isAwaitingUserAnswer", () => {
	test("a final-line question is detected", () => {
		expect(isAwaitingUserAnswer("Done with step 1.\nShould I proceed with step 2?")).toBe(true);
	});

	test("incidental question marks in code are not questions", () => {
		expect(isAwaitingUserAnswer("Fixed the type:\nfoo?: string")).toBe(false);
	});

	test("response cues are detected", () => {
		expect(isAwaitingUserAnswer("Two options exist.\nPlease confirm which one.")).toBe(true);
		expect(isAwaitingUserAnswer("Pick one: left or right.")).toBe(true);
	});

	test("non-ASCII text ending with ? is a question", () => {
		expect(isAwaitingUserAnswer("Работа окончена. Продолжить?")).toBe(true);
	});

	test("plain completion statements are not questions", () => {
		expect(isAwaitingUserAnswer("All tasks are complete. Nothing left to do.")).toBe(false);
	});

	test("empty text is not a question", () => {
		expect(isAwaitingUserAnswer("")).toBe(false);
	});
});

describe("stop reminder", () => {
	test("fires with incomplete work and counts attempts", () => {
		const engine = new TodoReminderEngine(makeConfig());
		const phases = phasesWith({ name: "P", tasks: [["A", "in_progress"]] });
		const first = engine.consumeStopReminder(phases, "Working...");
		expect(first?.incomplete[0]?.tasks[0]?.content).toBe("A");
		expect(first?.attempt).toBe(1);
		// awaiting progress: no second reminder until a tool result arrives
		expect(engine.consumeStopReminder(phases, "Working...")).toBeNull();
		engine.recordToolResult("bash", false);
		const second = engine.consumeStopReminder(phases, "Working...");
		expect(second?.attempt).toBe(2);
	});

	test("budget caps reminders at remindersMax", () => {
		const engine = new TodoReminderEngine(makeConfig({ remindersMax: 2 }));
		const phases = phasesWith({ name: "P", tasks: [["A", "pending"]] });
		expect(engine.consumeStopReminder(phases, "...")).not.toBeNull();
		engine.recordToolResult("bash", false);
		expect(engine.consumeStopReminder(phases, "...")).not.toBeNull();
		engine.recordToolResult("bash", false);
		expect(engine.consumeStopReminder(phases, "...")).toBeNull();
	});

	test("agent asking the user a question suppresses the reminder", () => {
		const engine = new TodoReminderEngine(makeConfig());
		const phases = phasesWith({ name: "P", tasks: [["A", "pending"]] });
		expect(engine.consumeStopReminder(phases, "Found two paths.\nWhich do you prefer?")).toBeNull();
		// and it does not burn the budget's awaiting-progress state
		expect(engine.consumeStopReminder(phases, "Continuing without asking.")).not.toBeNull();
	});

	test("disabled reminders never fire", () => {
		const engine = new TodoReminderEngine(makeConfig({ reminders: false }));
		const phases = phasesWith({ name: "P", tasks: [["A", "pending"]] });
		expect(engine.consumeStopReminder(phases, "...")).toBeNull();
	});

	test("fully-settled list resets the budget while it is not exhausted", () => {
		const engine = new TodoReminderEngine(makeConfig({ remindersMax: 3 }));
		const open = phasesWith({ name: "P", tasks: [["A", "in_progress"]] });
		const closed = phasesWith({ name: "P", tasks: [["A", "completed"]]});
		expect(engine.consumeStopReminder(open, "...")).not.toBeNull();
		engine.recordToolResult("bash", false);
		expect(engine.consumeStopReminder(closed, "...")).toBeNull();
		engine.recordToolResult("bash", false);
		const again = engine.consumeStopReminder(open, "...");
		expect(again?.attempt).toBe(1); // budget was reset, not incremented
	});

	test("exhausted budget stays exhausted for the rest of the cycle (OMP parity)", () => {
		const engine = new TodoReminderEngine(makeConfig({ remindersMax: 1 }));
		const open = phasesWith({ name: "P", tasks: [["A", "pending"]] });
		const closed = phasesWith({ name: "P", tasks: [["A", "completed"]] });
		expect(engine.consumeStopReminder(open, "...")).not.toBeNull();
		engine.recordToolResult("bash", false);
		expect(engine.consumeStopReminder(closed, "...")).toBeNull();
		engine.recordToolResult("bash", false);
		expect(engine.consumeStopReminder(open, "...")).toBeNull();
		engine.resetCycle();
		expect(engine.consumeStopReminder(open, "...")).not.toBeNull();
	});

	test("blocked-only work is not incomplete", () => {
		const engine = new TodoReminderEngine(makeConfig());
		const phases = phasesWith({ name: "P", tasks: [["A", "blocked"]] });
		expect(engine.consumeStopReminder(phases, "...")).toBeNull();
	});
});

describe("mid-run nudge", () => {
	test("fires only after the mutation threshold, resets on todo touch", () => {
		const engine = new TodoReminderEngine(makeConfig());
		const phases = phasesWith({ name: "P", tasks: [["A", "pending"]] });
		for (let i = 0; i < DEFAULT_REMINDER_CONFIG.midRunMutationThreshold - 1; i++) {
			engine.recordToolResult("bash", false);
			expect(engine.takeMidRunNudge(phases)).toBeNull();
		}
		engine.recordToolResult("bash", false);
		expect(engine.takeMidRunNudge(phases)).toBe(1);
		// a todo call resets the mutation counter
		engine.recordToolResult("todo", false);
		expect(engine.takeMidRunNudge(phases)).toBeNull();
	});

	test("max nudges per cycle; resetCycle restores the budget", () => {
		const engine = new TodoReminderEngine(makeConfig({ midRunMaxPerCycle: 2 }));
		const phases = phasesWith({ name: "P", tasks: [["A", "pending"]] });
		for (let n = 0; n < 2; n++) {
			for (let i = 0; i < DEFAULT_REMINDER_CONFIG.midRunMutationThreshold; i++) engine.recordToolResult("edit", false);
			expect(engine.takeMidRunNudge(phases)).not.toBeNull();
		}
		for (let i = 0; i < DEFAULT_REMINDER_CONFIG.midRunMutationThreshold; i++) engine.recordToolResult("edit", false);
		expect(engine.takeMidRunNudge(phases)).toBeNull();
		engine.resetCycle();
		for (let i = 0; i < DEFAULT_REMINDER_CONFIG.midRunMutationThreshold; i++) engine.recordToolResult("edit", false);
		expect(engine.takeMidRunNudge(phases)).not.toBeNull();
	});

	test("failed mutations do not count; disabled nudges never fire", () => {
		const engine = new TodoReminderEngine(makeConfig({ midRunNudges: false }));
		const phases = phasesWith({ name: "P", tasks: [["A", "pending"]] });
		for (let i = 0; i < DEFAULT_REMINDER_CONFIG.midRunMutationThreshold + 5; i++) engine.recordToolResult("bash", true);
		expect(engine.takeMidRunNudge(phases)).toBeNull();
	});
});

describe("helpers", () => {
	test("allTodosClosed requires at least one task and every task settled", () => {
		expect(allTodosClosed([])).toBe(false);
		expect(allTodosClosed(phasesWith({ name: "P", tasks: [["A", "completed"], ["B", "abandoned"]] }))).toBe(true);
		expect(allTodosClosed(phasesWith({ name: "P", tasks: [["A", "completed"], ["B", "pending"]] }))).toBe(false);
	});

	test("reminder text carries the list, the ask, and the counter", () => {
		const text = buildStopReminderText(
			[{ name: "P", tasks: [{ content: "A", status: "in_progress" }, { content: "B", status: "pending" }] }],
			2,
			3,
		);
		expect(text).toContain("<system-reminder>");
		expect(text).toContain("You stopped with 2 incomplete todo item(s):");
		expect(text).toContain("- P\n  - A\n  - B");
		expect(text).toContain("(Reminder 2/3)");
		expect(text).toContain("mark them complete if finished");
	});
});
