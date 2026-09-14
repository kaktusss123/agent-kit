import { realpathSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { resolveGitOnPath } from "./shim-path";

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
