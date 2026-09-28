/**
 * Integration-style tests for the model-classes extension surface (index.ts)
 * over a fake pi harness: the command matrix (status/set/unset/route/next),
 * the Ctrl+Alt+P shortcut sharing the cycle rule, dynamic completions, and
 * the failure paths. Storage runs against a throwaway agent dir; model
 * application is an in-memory fake with pi's reset-thinking-on-switch
 * behavior.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerExtension from "./index";
import { supportedThinkingLevels, type ModelLike } from "./core";
import type { ThinkingLevel } from "./store";

type RegisterFn = Parameters<typeof registerExtension>[0];

// ------------------------------------------------------------ fake pi/ctx

const MODEL_LIGHT: ModelLike = { provider: "zai", id: "glm-x", reasoning: true };
const MODEL_HEAVY: ModelLike = {
	provider: "prov-b",
	id: "openai/gpt-oss-120b",
	reasoning: true,
	thinkingLevelMap: { off: "off", medium: "m", high: "h", xhigh: "xh", max: "mx" },
};
const REGISTRY: ModelLike[] = [MODEL_LIGHT, MODEL_HEAVY];

interface Notify {
	text: string;
	kind: "info" | "error" | "warning";
}

function makePi() {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null }>();
	const shortcuts = new Map<string, { description?: string; handler: (ctx: unknown) => Promise<void> | void }>();
	const notifications: Notify[] = [];
	let currentModel: ModelLike = MODEL_LIGHT;
	let thinking: ThinkingLevel = "high";

	const pi = {
		registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null }) => {
			commands.set(name, options);
		},
		registerShortcut: (key: string, options: { description?: string; handler: (ctx: unknown) => Promise<void> | void }) => {
			shortcuts.set(key, options);
		},
		getThinkingLevel: () => thinking,
		setThinkingLevel: (level: ThinkingLevel) => {
			thinking = level;
		},
		// pi reselects the thinking level on a model switch (first supported)
		setModel: async (model: ModelLike) => {
			currentModel = model;
			thinking = supportedThinkingLevels(model)[0]!;
			return true;
		},
	};
	const ctx = {
		get model() {
			return currentModel;
		},
		modelRegistry: { getAll: () => REGISTRY },
		ui: { notify: (text: string, kind: "info" | "error" | "warning") => notifications.push({ text, kind }) },
	};
	return {
		pi,
		ctx,
		commands,
		shortcuts,
		notifications,
		state: () => ({ model: `${currentModel.provider}/${currentModel.id}`, thinking }),
		run: (args: string) => commands.get("model-class")!.handler(args, ctx),
		completions: (prefix: string) => commands.get("model-class")!.getArgumentCompletions?.(prefix) ?? null,
		pressCtrlAltP: () => shortcuts.get("ctrl+alt+p")!.handler(ctx),
		last: () => notifications[notifications.length - 1],
	};
}

/** Throwaway agent dir with seeded storage; removed only after the run settles. */
async function withAgentStorage<T>(
	stored: Record<string, unknown> | undefined,
	run: (dir: string, base: ReturnType<typeof makePi>) => T | Promise<T>,
): Promise<T> {
	const base = makePi();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-classes-index-test-"));
	if (stored !== undefined) {
		fs.writeFileSync(path.join(dir, "model-classes.json"), JSON.stringify(stored));
	}
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	registerExtension(base.pi as unknown as RegisterFn);
	try {
		return await run(dir, base);
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ------------------------------------------------------------------ tests

describe("registration", () => {
	test("registers the model-class command and the ctrl+alt+p shortcut", async () => {
		await withAgentStorage(undefined, (_dir, base) => {
			expect(base.commands.has("model-class")).toBe(true);
			expect(base.shortcuts.has("ctrl+alt+p")).toBe(true);
			expect(base.shortcuts.get("ctrl+alt+p")!.description).toContain("class");
		});
	});
});

describe("status", () => {
	test("lists the session pair, saved classes in order, and the routing table", async () => {
		await withAgentStorage(
			{
				workhorse: { model: "zai/glm-x", thinking: "low" },
				heavy: { model: "prov-b/openai/gpt-oss-120b", thinking: "xhigh" },
				routing: { repoOwner: "heavy", plain: "nosuch" },
			},
			async (_dir, base) => {
				await base.run("");
				const text = base.last()!.text;
				expect(text).toMatch(/default\s+zai\/glm-x\s+high/);
				expect(text.indexOf("workhorse")).toBeLessThan(text.indexOf("heavy"));
				expect(text).toContain("repoOwner  heavy");
				expect(text).toContain("plain      nosuch");
				expect(text).toContain("NOT SAVED");
				expect(base.last()!.kind).toBe("info");
			},
		);
	});
});

describe("set / switch", () => {
	test("set saves the live pair; switch applies a saved pair atomically", async () => {
		await withAgentStorage(undefined, async (dir, base) => {
			await base.run("workhorse set");
			expect(base.last()!.text).toBe("Saved workhorse: zai/glm-x, high");
			expect(JSON.parse(fs.readFileSync(path.join(dir, "model-classes.json"), "utf8"))).toEqual({
				workhorse: { model: "zai/glm-x", thinking: "high" },
			});
			// switch away and back through a stored class
			fs.writeFileSync(
				path.join(dir, "model-classes.json"),
				JSON.stringify({ workhorse: { model: "prov-b/openai/gpt-oss-120b", thinking: "medium" } }),
			);
			await base.run("workhorse");
			expect(base.last()!.text).toBe("Switched to workhorse: prov-b/openai/gpt-oss-120b, medium");
			expect(base.state()).toEqual({ model: "prov-b/openai/gpt-oss-120b", thinking: "medium" });
		});
	});

	test("switch to an unsaved class fails closed, session unchanged", async () => {
		await withAgentStorage(undefined, async (_dir, base) => {
			await base.run("nosuch");
			expect(base.last()!.kind).toBe("error");
			expect(base.last()!.text).toContain("not saved");
			expect(base.state()).toEqual({ model: "zai/glm-x", thinking: "high" });
		});
	});
});

describe("unset", () => {
	test("deletes a class; refuses while routed, naming the mode (A8)", async () => {
		await withAgentStorage(
			{ heavy: { model: "prov-b/openai/gpt-oss-120b", thinking: "high" }, routing: { repoOwner: "heavy" } },
			async (dir, base) => {
				await base.run("heavy unset");
				expect(base.last()!.kind).toBe("error");
				expect(base.last()!.text).toContain("repoOwner");
				// route reset unlocks the deletion
				await base.run("route repoOwner inherit");
				await base.run("heavy unset");
				expect(base.last()!.text).toBe("Deleted model class heavy");
				expect(JSON.parse(fs.readFileSync(path.join(dir, "model-classes.json"), "utf8"))).toEqual({
					routing: {},
				});
			},
		);
	});
});

describe("route", () => {
	test("route status shows the table; set validates the class and persists; reset inherits", async () => {
		await withAgentStorage({ workhorse: { model: "zai/glm-x", thinking: "low" } }, async (dir, base) => {
			await base.run("route");
			expect(base.last()!.text).toContain("plain      inherit");
			expect(base.last()!.text).toContain("repoOwner  inherit");

			await base.run("route plain nosuch");
			expect(base.last()!.kind).toBe("error");
			expect(base.last()!.text).toContain("/model-class nosuch set");

			await base.run("route plain workhorse");
			expect(base.last()!.text).toBe("Routing plain: workhorse (zai/glm-x, low)");
			expect(JSON.parse(fs.readFileSync(path.join(dir, "model-classes.json"), "utf8")).routing).toEqual({
				plain: "workhorse",
			});

			await base.run("route plain inherit");
			expect(base.last()!.text).toBe("Routing plain: inherit (session pair)");
			expect(JSON.parse(fs.readFileSync(path.join(dir, "model-classes.json"), "utf8")).routing).toEqual({});
		});
	});
});

describe("next / ctrl+alt+p (stateless cycle, R5/A9)", () => {
	const STORED = {
		workhorse: { model: "zai/glm-x", thinking: "low" },
		heavy: { model: "prov-b/openai/gpt-oss-120b", thinking: "high" },
	};

	test("session on the LAST class wraps to the FIRST; notifies with the applied pair", async () => {
		await withAgentStorage(STORED, async (_dir, base) => {
			base.pi.setModel(MODEL_HEAVY);
			base.pi.setThinkingLevel("high"); // session == heavy
			await base.run("next");
			expect(base.last()!.text).toBe("Switched to workhorse: zai/glm-x, low");
			expect(base.state()).toEqual({ model: "zai/glm-x", thinking: "low" });
		});
	});

	test("session matching no class goes to the FIRST class", async () => {
		await withAgentStorage(STORED, async (_dir, base) => {
			await base.run("next");
			expect(base.last()!.text).toBe("Switched to workhorse: zai/glm-x, low");
		});
	});

	test("the shortcut behaves identically to the command", async () => {
		await withAgentStorage(STORED, async (_dir, base) => {
			base.pi.setModel(MODEL_HEAVY);
			base.pi.setThinkingLevel("high");
			await base.pressCtrlAltP();
			expect(base.last()!.text).toBe("Switched to workhorse: zai/glm-x, low");
			expect(base.state()).toEqual({ model: "zai/glm-x", thinking: "low" });
		});
	});

	test("zero classes: informative error, model unchanged", async () => {
		await withAgentStorage(undefined, async (_dir, base) => {
			await base.run("next");
			expect(base.last()!.kind).toBe("error");
			expect(base.last()!.text).toContain("No saved model classes");
			expect(base.state()).toEqual({ model: "zai/glm-x", thinking: "high" });
			await base.pressCtrlAltP();
			expect(base.last()!.kind).toBe("error");
		});
	});

	test("a class whose model is dead fails the cycle without touching the session", async () => {
		await withAgentStorage({ heavy: { model: "gone/vanished", thinking: "high" } }, async (_dir, base) => {
			await base.run("next");
			expect(base.last()!.kind).toBe("error");
			expect(base.last()!.text).toContain("no longer available");
			expect(base.state()).toEqual({ model: "zai/glm-x", thinking: "high" });
		});
	});
});

describe("completions", () => {
	test("dynamic: saved classes, subcommands, route forms; unknown prefixes yield null", async () => {
		await withAgentStorage(
			{ workhorse: { model: "zai/glm-x", thinking: "low" }, heavy: { model: "zai/glm-x", thinking: "high" } },
			(_dir, base) => {
				const values = (prefix: string) => (base.completions(prefix) ?? []).map((i) => i.value);
				expect(values("")).toEqual(
					expect.arrayContaining(["workhorse", "heavy", "next", "route", "workhorse set", "workhorse unset"]),
				);
				expect(values("w")).toEqual(["workhorse", "workhorse set", "workhorse unset"]);
				expect(values("route ")).toEqual([
					"route plain",
					"route plain inherit",
					"route plain workhorse",
					"route plain heavy",
					"route repoOwner",
					"route repoOwner inherit",
					"route repoOwner workhorse",
					"route repoOwner heavy",
				]);
				expect(values("route plain")).toEqual(
					expect.arrayContaining(["route plain", "route plain inherit", "route plain workhorse", "route plain heavy"]),
				);
				expect(values("route repoOwner ")).toEqual(
					expect.arrayContaining(["route repoOwner inherit", "route repoOwner workhorse"]),
				);
				// unknown prefixes yield nothing (null), never guesses
				expect(base.completions("zzz")).toBeNull();
			},
		);
	});
});
