import { realpathSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import { resolveGitOnPath } from "./shim-path.ts";

test("resolveGitOnPath skips the excluded dir even when it is first on PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-kit-git-path-"));
  try {
    const shim = join(root, "shim");
    const shimGit = join(shim, "git");
    const bin = join(root, "bin");
    const realGit = join(bin, "git");
    await mkdir(shim);
    await mkdir(bin);
    await writeFile(shimGit, "#!/bin/sh\nexit 42\n");
    await chmod(shimGit, 0o755);
    await writeFile(realGit, "#!/bin/sh\nexit 0\n");
    await chmod(realGit, 0o755);

    const resolved = resolveGitOnPath(`${shim}:${bin}`, root, shim);

    expect(resolved).toBe(realpathSync(realGit));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveGitOnPath matches the excluded dir through a symlink by real path", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-kit-git-path-"));
  try {
    const shim = join(root, "shim");
    const shimGit = join(shim, "git");
    const shimLink = join(root, "shim-link");
    const bin = join(root, "bin");
    const realGit = join(bin, "git");
    await mkdir(shim);
    await mkdir(bin);
    await writeFile(shimGit, "#!/bin/sh\nexit 42\n");
    await chmod(shimGit, 0o755);
    await writeFile(realGit, "#!/bin/sh\nexit 0\n");
    await chmod(realGit, 0o755);
    await symlink(shim, shimLink);

    const resolved = resolveGitOnPath(`${shimLink}:${bin}`, root, shim);

    expect(resolved).toBe(realpathSync(realGit));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveGitOnPath skips a foreign shim copy dir and resolves later real git", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-kit-git-path-"));
  try {
    const foreign = join(root, "foreign-install");
    const foreignGit = join(foreign, "git");
    const bin = join(root, "bin");
    const realGit = join(bin, "git");
    await mkdir(foreign);
    await mkdir(bin);
    const shimScript = await readFile(join(import.meta.dirname, "shim", "git"), "utf8");
    await writeFile(foreignGit, shimScript);
    await chmod(foreignGit, 0o755);
    await writeFile(realGit, "#!/bin/sh\nexit 0\n");
    await chmod(realGit, 0o755);

    const resolved = resolveGitOnPath(`${foreign}:${bin}`, root, join(import.meta.dirname, "shim"));

    expect(resolved).toBe(realpathSync(realGit));
    // The content check alone must reject the copy even without excludeDir.
    expect(resolveGitOnPath(`${foreign}:${bin}`, root)).toBe(realpathSync(realGit));
    expect(resolveGitOnPath(foreign, root)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveGitOnPath keeps first-match-wins without an excluded dir", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-kit-git-path-"));
  try {
    const shim = join(root, "shim");
    const shimGit = join(shim, "git");
    const bin = join(root, "bin");
    const realGit = join(bin, "git");
    await mkdir(shim);
    await mkdir(bin);
    await writeFile(shimGit, "#!/bin/sh\nexit 42\n");
    await chmod(shimGit, 0o755);
    await writeFile(realGit, "#!/bin/sh\nexit 0\n");
    await chmod(realGit, 0o755);

    const resolved = resolveGitOnPath(`${shim}:${bin}`, root);

    expect(resolved).toBe(realpathSync(shimGit));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveGitOnPath freezes a relative PATH entry as an absolute real path", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-kit-git-path-"));
  try {
    const bin = join(root, "bin");
    const realGit = join(root, "real-git");
    const gitLink = join(bin, "git");
    await mkdir(bin);
    await writeFile(realGit, "#!/bin/sh\nexit 0\n");
    await chmod(realGit, 0o755);
    await symlink(realGit, gitLink);

    const resolved = resolveGitOnPath("missing:bin", root);

    expect(resolved).toBe(realpathSync(realGit));
    expect(resolved?.startsWith("/")).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
