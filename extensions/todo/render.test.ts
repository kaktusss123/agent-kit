import { describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { phasesWith } from "./test-fixtures.ts";
import { type TodoPhase, type TodoToolDetails } from "./core.ts";
import { buildCompactTodoLine, buildHudLines, renderTodoCall, renderTodoResult } from "./render.ts";

/** Plain-text fake theme: assertions read like `[accent]…[/accent]`. */
function fakeTheme(): Theme {
	const wrap = (color: string) => (text: string) => `[${color}]${text}[/${color}]`;
	return {
		fg: (color, text) => wrap(color)(text),
		bold: (text: string) => `**${text}**`,
		strikethrough: (text: string) => `~~${text}~~`,
	} as unknown as Theme;
}

const theme = fakeTheme();

function samplePhases(): TodoPhase[] {
	const phases = phasesWith(
		{ name: "Foundation", tasks: [["Scaffold crate", "completed"], ["Wire workspace", "in_progress"]] },
		{ name: "Auth", tasks: [["Port credential store", "pending"], ["Wire OAuth", "blocked"]] },
		{ name: "Verify", tasks: [["Run tests", "pending"]] },
	);
	phases[1]!.tasks[1]!.blocker = "waiting on decision";
	return phases;
}

describe("renderTodoResult", () => {
	test("error results render the failure, not a list", () => {
		const out = renderTodoResult({ isError: true, content: [{ type: "text", text: "boom" }] }, { expanded: false, isPartial: false }, theme);
		const lines = out.render(80);
		expect(lines.join("\n")).toContain("[error]✗ boom[/error]");
	});

	test("card header shows phase count and task totals", () => {
		const details: TodoToolDetails = { op: "view", phases: samplePhases() };
		const out = renderTodoResult({ details }, { expanded: false, isPartial: false }, theme);
		const text = out.render(200).join("\n");
		expect(text).toContain("Todo");
		expect(text).toContain("5 tasks");
		expect(text).toContain("I. Foundation");
		expect(text).toContain("1/2");
	});

	test("completed tasks are struck through, blocked tasks carry the reason", () => {
		const details: TodoToolDetails = { op: "view", phases: samplePhases() };
		const text = renderTodoResult({ details }, { expanded: true, isPartial: false }, theme).render(200).join("\n");
		expect(text).toContain("~~Scaffold crate~~");
		expect(text).toContain("(blocked: waiting on decision)");
	});

	test("collapsed card hides closed rows and shows a hidden-count summary", () => {
		const many = phasesWith({
			name: "P",
			tasks: [
				["t1", "completed"],
				["t2", "in_progress"],
				["t3", "pending"],
				["t4", "pending"],
				["t5", "pending"],
				["t6", "pending"],
				["t7", "pending"],
			],
		});
		const collapsed = renderTodoResult({ details: { op: "view", phases: many } }, { expanded: false, isPartial: false }, theme)
			.render(200)
			.join("\n");
		expect(collapsed).toContain("t2"); // active task leads
		expect(collapsed).toContain("t1"); // closed lead context
		expect(collapsed).not.toContain("t7"); // beyond cap
		expect(collapsed).toContain("more");
		const expanded = renderTodoResult({ details: { op: "view", phases: many } }, { expanded: true, isPartial: false }, theme)
			.render(200)
			.join("\n");
		expect(expanded).toContain("t7"); // expanded shows everything
	});

	test("call preview shows op and target", () => {
		const text = renderTodoCall({ op: "done", task: "Wire workspace" }, theme).render(200).join("\n");
		expect(text).toContain("done");
		expect(text).toContain("Wire workspace");
	});
});

describe("buildHudLines", () => {
	test("HUD renders title, phases with roman numerals, and a spine", () => {
		const lines = buildHudLines(samplePhases(), false, false, 120, theme);
		const text = lines.join("\n");
		expect(lines[0]).toContain("TODO");
		expect(text).toContain("I. Foundation");
		expect(text).toContain("├─");
		expect(text).toContain("└");
		expect(text).toContain("1/2"); // phase progress
	});

	test("collapsed HUD starts at the active phase and shows following stages within cap", () => {
		const lines = buildHudLines(samplePhases(), false, false, 120, theme);
		const text = lines.join("\n");
		expect(text).toContain("Foundation"); // active phase
		expect(text).toContain("Auth");
		expect(text).toContain("Verify"); // 2 following stages fit under cap 4
	});

	test("stages beyond the cap collapse into a summary row", () => {
		const many = phasesWith(...Array.from({ length: 7 }, (_, i) => ({
			name: `S${i + 1}`,
			tasks: [["t", i === 0 ? "in_progress" : "pending"]] as Array<[string, TodoPhase["tasks"][number]["status"]]>,
		})));
		const text = buildHudLines(many, false, false, 120, theme).join("\n");
		expect(text).toContain("S1");
		expect(text).not.toContain("S6"); // cap 4 subsequent stages exceeded
		expect(text).toContain("2 more stages");
	});

	test("expanded HUD lists every stage", () => {
		const text = buildHudLines(samplePhases(), true, false, 120, theme).join("\n");
		expect(text).toContain("Verify");
		expect(text).not.toContain("more stages");
	});

	test("progress spine fills with closed tasks", () => {
		const closed = phasesWith({ name: "P", tasks: [["A", "completed"], ["B", "completed"]] });
		const lines = buildHudLines(closed, false, false, 120, theme);
		// the header line is index 0; every spine cell below is accent-filled
		const accentCells = lines.slice(1).filter(line => line.startsWith("[accent]"));
		expect(accentCells.length).toBeGreaterThan(0);
	});

	test("empty phases render nothing; compact mode renders one bounded line", () => {
		expect(buildHudLines([], false, false, 120, theme)).toEqual([]);
		const compact = buildCompactTodoLine(samplePhases(), theme);
		expect(compact).toContain("TODO");
		expect(compact).toContain("1/5"); // closed/total
		expect(compact).toContain("Wire workspace"); // actionable task
	});

	test("lines never exceed the terminal width", () => {
		const wide = phasesWith({ name: "P".repeat(60), tasks: [["x".repeat(200), "in_progress"]] });
		for (const line of buildHudLines(wide, true, false, 40, theme)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		}
	});
});
