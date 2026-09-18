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

	test("directory manifest entries resolve to the package ROOT (pi loads its own manifest)", () => {
		const pkg = makePackage({
			manifest: { name: "pkg", pi: { extensions: ["./extensions", "./missing-dir"] } },
			extensionsDirWith: ["cloudru-provider.ts"],
		});
		// Live-verified: `-e <resolved dir>` fails with "module not found" —
		// pi treats a -e directory as an extension in its own right. The
		// package root is the only reliable entry for directory entries.
		const entries = packageExtensionEntries(pkg.installedPath!);
		expect(entries).toEqual([pkg.installedPath]);
	});

	test("file manifest entries are passed as exact file paths", () => {
		const pkg = makePackage({ manifest: { name: "pkg", pi: { extensions: ["./single.ts"] } }, extensionsDirWith: ["x.ts"] });
		fs.writeFileSync(path.join(pkg.installedPath!, "single.ts"), "// ext\n");
		const entries = packageExtensionEntries(pkg.installedPath!);
		expect(entries).toEqual([path.join(pkg.installedPath!, "single.ts")]);
	});

	test("packageExtensionEntries falls back to the package ROOT (a -e directory is a single file)", () => {
		// Manifest-less package with an extensions/ dir: the ROOT, never the dir.
		const withDir = makePackage({ manifest: { name: "pkg" }, extensionsDirWith: ["provider.ts"] });
		expect(packageExtensionEntries(withDir.installedPath!)).toEqual([withDir.installedPath]);

		// Neither manifest entry nor extensions/ dir: the package dir itself.
		const bare = makePackage({ manifest: { name: "pkg" } });
		expect(packageExtensionEntries(bare.installedPath!)).toEqual([bare.installedPath]);

		// Broken/absent manifest with extensions/ dir: still the ROOT.
		const broken = makePackage({ manifest: null, extensionsDirWith: ["provider.ts"] });
		expect(packageExtensionEntries(broken.installedPath!)).toEqual([broken.installedPath]);
	});

	test("packageExtensionEntries: declared entries that do not exist are not passed", () => {
		const pkg = makePackage({ manifest: { pi: { extensions: ["./nope.ts"] } }, extensionsDirWith: ["y.ts"] });
		// All declared entries missing → falls back to the package ROOT.
		expect(packageExtensionEntries(pkg.installedPath!)).toEqual([pkg.installedPath]);
	});

	test("resolver: manifest-less package with extensions/provider.ts yields the package root", () => {
		const pkg = makePackage({ manifest: { name: "pkg" }, extensionsDirWith: ["provider.ts"] });
		const resolved = resolveProviderExtensions("cloudru/Qwen/Qwen3.5", facts(["cloudru"], [pkg]));
		expect(resolved).toEqual({ kind: "ok", entries: [pkg.installedPath] });
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
			entries: [pkg.installedPath],
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
		expect(requireProviderExtensions("cloudru/m", facts(["cloudru"], [pkg]))).toEqual([pkg.installedPath]);
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
