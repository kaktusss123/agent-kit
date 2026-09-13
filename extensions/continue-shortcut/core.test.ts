import { describe, expect, test } from "bun:test";
import { type ContinueInputEvent, decideContinueShortcut } from "./core";

const idle = (text: string, hasImages = false): ContinueInputEvent => ({
	text,
	hasImages,
	streamingBehavior: undefined,
});

describe("continue shortcut matching", () => {
	test('bare "." and "c" trigger while idle', () => {
		expect(decideContinueShortcut(idle("."))).toBe("trigger");
		expect(decideContinueShortcut(idle("c"))).toBe("trigger");
	});

	test("surrounding whitespace is trimmed before matching", () => {
		expect(decideContinueShortcut(idle(" . "))).toBe("trigger");
		expect(decideContinueShortcut(idle("\tc\n"))).toBe("trigger");
	});

	test("case and lookalikes stay prose", () => {
		expect(decideContinueShortcut(idle("C"))).toBe("pass-through");
		expect(decideContinueShortcut(idle(".."))).toBe("pass-through");
		expect(decideContinueShortcut(idle("c."))).toBe("pass-through");
		expect(decideContinueShortcut(idle(".c"))).toBe("pass-through");
		expect(decideContinueShortcut(idle("continue"))).toBe("pass-through");
		expect(decideContinueShortcut(idle(""))).toBe("pass-through");
		expect(decideContinueShortcut(idle("   "))).toBe("pass-through");
	});
});

describe("continue shortcut guards", () => {
	test("submissions with images pass through untouched", () => {
		expect(decideContinueShortcut(idle(".", true))).toBe("pass-through");
		expect(decideContinueShortcut(idle("c", true))).toBe("pass-through");
	});

	test("mid-stream steer submission is a no-op, not a trigger", () => {
		expect(decideContinueShortcut({ text: ".", hasImages: false, streamingBehavior: "steer" })).toBe("ignore");
		expect(decideContinueShortcut({ text: "c", hasImages: false, streamingBehavior: "steer" })).toBe("ignore");
	});

	test("explicit followUp queueing still triggers", () => {
		expect(decideContinueShortcut({ text: ".", hasImages: false, streamingBehavior: "followUp" })).toBe("trigger");
	});

	test("steer guard applies only to matching text", () => {
		expect(decideContinueShortcut({ text: "..", hasImages: false, streamingBehavior: "steer" })).toBe("pass-through");
		expect(decideContinueShortcut({ text: "look at this", hasImages: false, streamingBehavior: "steer" })).toBe(
			"pass-through",
		);
	});
});
