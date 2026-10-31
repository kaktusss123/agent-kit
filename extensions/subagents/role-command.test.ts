/** Unit tests for the /subagent-role command logic. */
import { afterEach, describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { roleCommandCompletions, runRoleCommand } from "./role-command.ts";
import { loadRoleBindings } from "./roles.ts";
import type { ModelLike } from "./model-spec.ts";

const REGISTRY: ModelLike[] = [
	{ provider: "zai", id: "glm-x", reasoning: true },
	{ provider: "zai", id: "glm-max", reasoning: true, thinkingLevelMap: { xhigh: "xh" } },
];
const dirs: string[] = [];
function deps(model: ModelLike | undefined = REGISTRY[0]) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "role-command-test-"));
	dirs.push(dir);
	return { file: path.join(dir, "subagent-roles.json"), model, thinking: "low" as const, registry: REGISTRY };
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("runRoleCommand", () => {
	test("no args shows every role with its effective model", () => {
		const d = deps();
		fs.writeFileSync(d.file, JSON.stringify({ review: "zai/glm-max:xhigh" }));
		const r = runRoleCommand("", d);
		expect(r.kind).toBe("info");
		expect(r.text).toMatch(/review\s+zai\/glm-max:xhigh/);
		expect(r.text).toMatch(/explore\s+session/);
		expect(r.text).toMatch(/owner\s+session/);
	});

	test("set validates against the registry and persists what was typed", () => {
		const d = deps();
		expect(runRoleCommand("review zai/glm-max:xhigh", d).kind).toBe("info");
		expect(loadRoleBindings(d.file)).toEqual({ review: "zai/glm-max:xhigh" });
		expect(runRoleCommand("explore zai/glm-x", d).kind).toBe("info");
		expect(loadRoleBindings(d.file).explore).toBe("zai/glm-x");
	});

	test("invalid model, unsupported thinking, unknown role, and extra args do not write", () => {
		const d = deps();
		for (const args of ["review nosuch/m", "review zai/glm-x:xhigh", "fast zai/glm-x", "review", "review a b"]) {
			expect(runRoleCommand(args, d).kind, args).toBe("error");
		}
		expect(fs.existsSync(d.file)).toBe(false);
	});

	test("current saves the session model with its thinking level", () => {
		const d = deps();
		expect(runRoleCommand("owner current", d).kind).toBe("info");
		expect(loadRoleBindings(d.file)).toEqual({ owner: "zai/glm-x:low" });
		expect(runRoleCommand("owner current", { ...d, model: undefined }).kind).toBe("error");
	});

	test("unset removes the binding", () => {
		const d = deps();
		runRoleCommand("review zai/glm-x", d);
		expect(runRoleCommand("review unset", d).text).toContain("unbound");
		expect(loadRoleBindings(d.file)).toEqual({});
		expect(runRoleCommand("review unset", d).text).toContain("nothing to remove");
	});

	test("a corrupt file surfaces as an error result, not a throw", () => {
		const d = deps();
		fs.writeFileSync(d.file, "{ nope");
		expect(runRoleCommand("", d).kind).toBe("error");
		expect(runRoleCommand("review zai/glm-x", d).kind).toBe("error");
	});
});

describe("roleCommandCompletions", () => {
	test("filters by prefix", () => {
		expect(roleCommandCompletions("re")).toEqual(["review", "review current", "review unset"]);
	});
});
