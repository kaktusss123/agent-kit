/** Unit tests for role bindings storage: fresh reads, strict validation, atomic writes. */
import { afterEach, describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadRoleBindings, rolesPath, saveRoleBinding, unsetRoleBinding } from "./roles.ts";

const dirs: string[] = [];
function tmpFile(content?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roles-test-"));
	dirs.push(dir);
	const file = path.join(dir, "subagent-roles.json");
	if (content !== undefined) fs.writeFileSync(file, content);
	return file;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("rolesPath", () => {
	test("honors an explicit dir and PI_CODING_AGENT_DIR", () => {
		expect(rolesPath("/x")).toBe("/x/subagent-roles.json");
		const prev = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = "/custom";
		try {
			expect(rolesPath()).toBe("/custom/subagent-roles.json");
		} finally {
			if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prev;
		}
	});
});

describe("loadRoleBindings", () => {
	test("missing and empty files mean nothing is bound", () => {
		expect(loadRoleBindings(tmpFile())).toEqual({});
		expect(loadRoleBindings(tmpFile("  \n"))).toEqual({});
	});

	test("reads valid bindings", () => {
		expect(loadRoleBindings(tmpFile(JSON.stringify({ review: "p/m:high", explore: "p/cheap" })))).toEqual({
			review: "p/m:high",
			explore: "p/cheap",
		});
	});

	test("corrupt JSON, non-object, unknown key, and bad value all throw naming the file", () => {
		for (const content of ["{ nope", "[]", '{"fast":"p/m"}', '{"review":3}', '{"review":""}']) {
			const file = tmpFile(content);
			expect(() => loadRoleBindings(file), content).toThrow(file);
		}
	});
});

describe("saveRoleBinding / unsetRoleBinding", () => {
	test("save creates the file (and dir), preserves other roles, leaves no tmp file", () => {
		const file = path.join(tmpFile(), "..", "nested", "subagent-roles.json");
		saveRoleBinding(file, "review", "p/m:high");
		saveRoleBinding(file, "explore", "p/cheap");
		expect(loadRoleBindings(file)).toEqual({ review: "p/m:high", explore: "p/cheap" });
		expect(fs.existsSync(`${file}.tmp`)).toBe(false);
		fs.rmSync(path.dirname(file), { recursive: true, force: true });
	});

	test("unset removes one binding and reports whether it existed", () => {
		const file = tmpFile(JSON.stringify({ review: "p/m", explore: "p/c" }));
		expect(unsetRoleBinding(file, "review")).toBe(true);
		expect(unsetRoleBinding(file, "review")).toBe(false);
		expect(loadRoleBindings(file)).toEqual({ explore: "p/c" });
	});

	test("the fix advice says to edit/delete and rebind, not to unset", () => {
		const file = tmpFile("{nope");
		expect(() => loadRoleBindings(file)).toThrow(/edit the file by hand.*delete it and rebind.*cannot repair/);
	});

	test("a corrupt file aborts writes and is left untouched", () => {
		const file = tmpFile("{ nope");
		expect(() => saveRoleBinding(file, "review", "p/m")).toThrow(file);
		expect(() => unsetRoleBinding(file, "review")).toThrow(file);
		expect(fs.readFileSync(file, "utf8")).toBe("{ nope");
	});
});
