/**
 * Tests for provider-extension resolution (pure module): package manifest
 * entry resolution against real tmp fixtures, the extension-registered
 * provider decision, and the needed-but-missing fail-fast.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	modelProvider,
	missingProviderMessage,
	packageExtensionEntries,
	requireProviderExtensions,
	resolveProviderExtensions,
	ProviderExtensionError,
	type ConfiguredPackageRef,
} from "./provider-extensions";

function makePackage(opts: {
	manifest?: Record<string, unknown> | null;
	extensionsDirWith?: string[];
	installed?: boolean;
}): ConfiguredPackageRef {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-pkg-"));
	if (!(opts.installed ?? true)) {
		fs.rmSync(dir, { recursive: true, force: true });
		return { source: "git:example/pkg", installedPath: path.join(os.tmpdir(), "provider-pkg-absent") };
	}
	if (opts.manifest !== null) {
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify(opts.manifest ?? { name: "pkg", pi: { extensions: ["./extensions"] } }),
		);
	}
	if (opts.extensionsDirWith) {
		fs.mkdirSync(path.join(dir, "extensions"));
		for (const f of opts.extensionsDirWith) fs.writeFileSync(path.join(dir, "extensions", f), "// ext\n");
	}
	return { source: "git:example/pkg", installedPath: dir };
}

const facts = (
	providerIds: string[],
	packages: ConfiguredPackageRef[],
) => ({ registeredProviderIds: providerIds, listPackages: () => packages });

describe("provider-extensions", () => {
	test("modelProvider splits provider/id and tolerates missing slashes", () => {
		expect(modelProvider("cloudru/Qwen/Qwen3.5")).toBe("cloudru");
		expect(modelProvider("zai/glm")).toBe("zai");
		expect(modelProvider("solo")).toBe("solo");
		expect(modelProvider(undefined)).toBe("");
	});

	test("packageExtensionEntries resolves pi.extensions against the installed path", () => {
		const pkg = makePackage({
			manifest: { name: "pkg", pi: { extensions: ["./extensions", "./missing-dir"] } },
			extensionsDirWith: ["cloudru-provider.ts"],
		});
		const entries = packageExtensionEntries(pkg.installedPath!);
		expect(entries).toEqual([path.join(pkg.installedPath!, "extensions")]);
	});

	test("packageExtensionEntries falls back: extensions/ dir, then the package dir itself", () => {
		// No pi.extensions in the manifest, extensions/ dir exists.
		const withDir = makePackage({ manifest: { name: "pkg" }, extensionsDirWith: ["x.ts"] });
		expect(packageExtensionEntries(withDir.installedPath!)).toEqual([path.join(withDir.installedPath!, "extensions")]);

		// Neither manifest entry nor extensions/ dir: the package dir itself.
		const bare = makePackage({ manifest: { name: "pkg" } });
		expect(packageExtensionEntries(bare.installedPath!)).toEqual([bare.installedPath]);

		// Broken/absent manifest with extensions/ dir still resolves the dir.
		const broken = makePackage({ manifest: null, extensionsDirWith: ["x.ts"] });
		expect(packageExtensionEntries(broken.installedPath!)).toEqual([path.join(broken.installedPath!, "extensions")]);
	});

	test("packageExtensionEntries: declared entries that do not exist are not passed", () => {
		const pkg = makePackage({ manifest: { pi: { extensions: ["./nope.ts"] } }, extensionsDirWith: ["y.ts"] });
		// All declared entries missing → falls back to the extensions/ dir.
		expect(packageExtensionEntries(pkg.installedPath!)).toEqual([path.join(pkg.installedPath!, "extensions")]);
	});

	test("not needed: provider not in the extension-registered set (builtin or unknown)", () => {
		const pkg = makePackage({ extensionsDirWith: ["a.ts"] });
		expect(resolveProviderExtensions("zai/glm", facts([], [pkg]))).toEqual({ kind: "not-needed" });
		expect(resolveProviderExtensions("openai-codex/gpt", facts(["cloudru"], [pkg]))).toEqual({ kind: "not-needed" });
		expect(resolveProviderExtensions(undefined, facts(["cloudru"], [pkg]))).toEqual({ kind: "not-needed" });
	});

	test("needed + installed package resolves existing entries (the propagation case)", () => {
		const pkg = makePackage({ extensionsDirWith: ["cloudru-provider.ts"] });
		const resolved = resolveProviderExtensions("cloudru/Qwen/Qwen3.5", facts(["cloudru", "llama.cpp"], [pkg]));
		expect(resolved).toEqual({
			kind: "ok",
			entries: [path.join(pkg.installedPath!, "extensions")],
		});
	});

	test("needed but package not installed → skipped, never installed (missing)", () => {
		const uninstalled = makePackage({ installed: false });
		const resolved = resolveProviderExtensions("cloudru/Qwen/Qwen3.5", facts(["cloudru"], [uninstalled]));
		expect(resolved.kind).toBe("missing");
		if (resolved.kind === "missing") {
			expect(resolved.provider).toBe("cloudru");
			expect(resolved.message).toBe(missingProviderMessage("cloudru/Qwen/Qwen3.5", "cloudru"));
			expect(resolved.message).toContain("cloudru/Qwen/Qwen3.5");
			expect(resolved.message).toContain("pi install");
		}
	});

	test("needed but nothing installed at all → missing (the fail-fast case)", () => {
		const resolved = resolveProviderExtensions("cloudru/m", facts(["cloudru"], []));
		expect(resolved.kind).toBe("missing");
	});

	test("requireProviderExtensions throws ProviderExtensionError only for the missing case", () => {
		const pkg = makePackage({ extensionsDirWith: ["p.ts"] });
		expect(requireProviderExtensions("cloudru/m", facts(["cloudru"], [pkg]))).toEqual([
			path.join(pkg.installedPath!, "extensions"),
		]);
		expect(requireProviderExtensions("zai/g", facts(["cloudru"], [])).length).toBe(0);

		expect(() => requireProviderExtensions("cloudru/m", facts(["cloudru"], []))).toThrow(ProviderExtensionError);
		try {
			requireProviderExtensions("cloudru/m", facts(["cloudru"], []));
			throw new Error("expected ProviderExtensionError");
		} catch (e) {
			expect(e).toBeInstanceOf(ProviderExtensionError);
			expect((e as Error).name).toBe("ProviderExtensionError");
			expect((e as Error).message).toContain("pi install");
		}
	});
});
