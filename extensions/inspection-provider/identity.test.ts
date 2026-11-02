/**
 * Identity resolution tests: `adapterVersion` and `buildRevision` must come
 * from files that describe the code being loaded, so each supported layout
 * (repository checkout, linked worktree, pinned snapshot release, declared
 * package version) is reproduced on disk here. Git plumbing is read straight
 * from the files rather than through `git rev-parse`, so these fixtures are
 * also the proof that no subprocess is involved.
 */
import { describe, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect } from "../../tests/support/expect.ts";
import { resolveProviderIdentity } from "./identity.ts";

const REVISION = "0123456789abcdef0123456789abcdef01234567";

function fixtureTree(build: (root: string) => string): { root: string; moduleDir: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-kit-inspection-identity-"));
	const moduleDir = build(root);
	return { root, moduleDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function writeFile(target: string, content: string): void {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
}

describe("provider identity", () => {
	test("a snapshot release takes the revision from its manifest", () => {
		const tree = fixtureTree((root) => {
			const release = path.join(root, "releases", REVISION);
			writeFile(path.join(release, "manifest.json"), JSON.stringify({ schema: 2, sha: REVISION, dirty: false }));
			const moduleDir = path.join(release, "extensions", "inspection-provider");
			fs.mkdirSync(moduleDir, { recursive: true });
			return moduleDir;
		});
		try {
			expect(resolveProviderIdentity(tree.moduleDir)).toEqual({
				adapterVersion: `agent-kit@${REVISION.slice(0, 12)}`,
				buildRevision: REVISION,
			});
		} finally {
			tree.cleanup();
		}
	});

	test("a repository checkout reads HEAD through a symbolic ref", () => {
		const tree = fixtureTree((root) => {
			writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/feat/thing\n");
			writeFile(path.join(root, ".git", "refs", "heads", "feat", "thing"), `${REVISION}\n`);
			const moduleDir = path.join(root, "extensions", "inspection-provider");
			fs.mkdirSync(moduleDir, { recursive: true });
			return moduleDir;
		});
		try {
			expect(resolveProviderIdentity(tree.moduleDir).buildRevision).toBe(REVISION);
		} finally {
			tree.cleanup();
		}
	});

	test("a linked worktree resolves HEAD and refs through its gitdir and commondir", () => {
		const tree = fixtureTree((root) => {
			const common = path.join(root, "repo", ".git");
			writeFile(path.join(common, "refs", "heads", "feat"), `${REVISION}\n`);
			const gitDir = path.join(common, "worktrees", "wt");
			writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/feat\n");
			writeFile(path.join(gitDir, "commondir"), "../..\n");
			writeFile(path.join(root, "wt", ".git"), `gitdir: ${gitDir}\n`);
			const moduleDir = path.join(root, "wt", "extensions", "inspection-provider");
			fs.mkdirSync(moduleDir, { recursive: true });
			return moduleDir;
		});
		try {
			expect(resolveProviderIdentity(tree.moduleDir).buildRevision).toBe(REVISION);
		} finally {
			tree.cleanup();
		}
	});

	test("a symlinked install resolves identity from the real checkout", () => {
		// The normal Pi layout: the agent extensions directory holds one symlink
		// per extension, so the loaded module path is not inside the repository.
		const tree = fixtureTree((root) => {
			writeFile(path.join(root, "repo", ".git", "HEAD"), `${REVISION}\n`);
			fs.mkdirSync(path.join(root, "repo", "extensions", "inspection-provider"), { recursive: true });
			const install = path.join(root, "agent", "extensions", "inspection-provider");
			fs.mkdirSync(path.dirname(install), { recursive: true });
			fs.symlinkSync(path.join(root, "repo", "extensions", "inspection-provider"), install, "dir");
			return install;
		});
		try {
			expect(resolveProviderIdentity(tree.moduleDir)).toEqual(resolveProviderIdentity(path.join(tree.root, "repo", "extensions", "inspection-provider")));
			expect(resolveProviderIdentity(tree.moduleDir)).toEqual({
				adapterVersion: `agent-kit@${REVISION.slice(0, 12)}`,
				buildRevision: REVISION,
			});
		} finally {
			tree.cleanup();
		}
	});

	test("a symlinked install pointing at a pinned release reads its manifest", () => {
		const tree = fixtureTree((root) => {
			const release = path.join(root, "releases", REVISION);
			writeFile(path.join(release, "manifest.json"), JSON.stringify({ schema: 2, sha: REVISION, dirty: false }));
			fs.mkdirSync(path.join(release, "extensions", "inspection-provider"), { recursive: true });
			const install = path.join(root, "agent", "extensions", "inspection-provider");
			fs.mkdirSync(path.dirname(install), { recursive: true });
			fs.symlinkSync(path.join(release, "extensions", "inspection-provider"), install, "dir");
			return install;
		});
		try {
			expect(resolveProviderIdentity(tree.moduleDir)).toEqual({
				adapterVersion: `agent-kit@${REVISION.slice(0, 12)}`,
				buildRevision: REVISION,
			});
		} finally {
			tree.cleanup();
		}
	});

	test("a packed ref and a detached HEAD both resolve", () => {
		const packed = fixtureTree((root) => {
			writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
			writeFile(path.join(root, ".git", "packed-refs"), `# pack-refs with: peeled\n${REVISION} refs/heads/main\n`);
			const moduleDir = path.join(root, "extensions", "inspection-provider");
			fs.mkdirSync(moduleDir, { recursive: true });
			return moduleDir;
		});
		const detached = fixtureTree((root) => {
			writeFile(path.join(root, ".git", "HEAD"), `${REVISION}\n`);
			const moduleDir = path.join(root, "extensions", "inspection-provider");
			fs.mkdirSync(moduleDir, { recursive: true });
			return moduleDir;
		});
		try {
			expect(resolveProviderIdentity(packed.moduleDir).buildRevision).toBe(REVISION);
			expect(resolveProviderIdentity(detached.moduleDir).buildRevision).toBe(REVISION);
		} finally {
			packed.cleanup();
			detached.cleanup();
		}
	});

	test("a declared package version wins over the revision and keeps the revision diagnostic", () => {
		const tree = fixtureTree((root) => {
			writeFile(path.join(root, "package.json"), JSON.stringify({ name: "agent-kit", version: "1.2.3" }));
			writeFile(path.join(root, ".git", "HEAD"), `${REVISION}\n`);
			const moduleDir = path.join(root, "extensions", "inspection-provider");
			fs.mkdirSync(moduleDir, { recursive: true });
			return moduleDir;
		});
		try {
			expect(resolveProviderIdentity(tree.moduleDir)).toEqual({ adapterVersion: "agent-kit@1.2.3", buildRevision: REVISION });
		} finally {
			tree.cleanup();
		}
	});

	test("a copied tree without git or manifest reports unknown instead of guessing", () => {
		const tree = fixtureTree((root) => {
			const moduleDir = path.join(root, "extensions", "inspection-provider");
			fs.mkdirSync(moduleDir, { recursive: true });
			writeFile(path.join(root, "manifest.json"), JSON.stringify({ schema: 2, sha: "not-a-revision" }));
			return moduleDir;
		});
		try {
			expect(resolveProviderIdentity(tree.moduleDir)).toEqual({ adapterVersion: "agent-kit@unknown", buildRevision: null });
		} finally {
			tree.cleanup();
		}
	});

	test("a ref that escapes the repository is refused", () => {
		const tree = fixtureTree((root) => {
			writeFile(path.join(root, "outside"), `${REVISION}\n`);
			writeFile(path.join(root, "repo", ".git", "HEAD"), "ref: ../outside\n");
			const moduleDir = path.join(root, "repo", "extensions", "inspection-provider");
			fs.mkdirSync(moduleDir, { recursive: true });
			return moduleDir;
		});
		try {
			expect(resolveProviderIdentity(tree.moduleDir)).toEqual({ adapterVersion: "agent-kit@unknown", buildRevision: null });
		} finally {
			tree.cleanup();
		}
	});
});
