import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
interface HookContext {
  command: string;
  cwd: string;
  env: Record<string, string>;
}

const INDEX_PATH = join(import.meta.dirname, "index.ts");
const SHIM_DIR = join(import.meta.dirname, "shim");

function runHook(context: HookContext, taskRoot: string): HookContext {
  const script = `
    const { armGitShim } = await import(${JSON.stringify(INDEX_PATH)});
    console.log(JSON.stringify(armGitShim(${JSON.stringify(taskRoot)})(${JSON.stringify(context)})));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }),
  ) as HookContext;
}

test("armGitShim resolves relative PATH entries against the bash child cwd", async () => {
  const cache = join(homedir(), ".cache");
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, "agent-kit-arm-git-shim-"));
  try {
    const bin = join(root, "bin");
    const git = join(bin, "git");
    await mkdir(bin);
    await writeFile(git, "#!/bin/sh\nexit 0\n");
    await chmod(git, 0o755);

    const context = {
      command: "git status",
      cwd: root,
      env: { PATH: "bin:/definitely/missing" },
    };
    const result = runHook(context, join(root, "tasks"));

    expect(result.env.AGENT_KIT_REAL_GIT).toBe(realpathSync(git));
    expect(result.env.PATH).toBe(`${SHIM_DIR}:${context.env.PATH}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("armGitShim never selects the shim itself when PATH already starts with the shim dir", async () => {
  const cache = join(homedir(), ".cache");
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, "agent-kit-arm-git-shim-"));
  try {
    const bin = join(root, "bin");
    const git = join(bin, "git");
    await mkdir(bin);
    await writeFile(git, "#!/bin/sh\nexit 0\n");
    await chmod(git, 0o755);

    const context = {
      command: "git status",
      cwd: root,
      env: { PATH: `${SHIM_DIR}:${bin}` },
    };
    const result = runHook(context, join(root, "tasks"));

    expect(result.env.AGENT_KIT_REAL_GIT).toBe(realpathSync(git));
    expect(result.env.AGENT_KIT_REAL_GIT).not.toBe(join(SHIM_DIR, "git"));
    expect(result.env.PATH).toBe(`${SHIM_DIR}:${context.env.PATH}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("armGitShim never selects a foreign shim copy dir when it is first on PATH", async () => {
  const cache = join(homedir(), ".cache");
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, "agent-kit-arm-git-shim-"));
  try {
    const foreign = join(root, "foreign-install");
    const foreignGit = join(foreign, "git");
    const bin = join(root, "bin");
    const git = join(bin, "git");
    await mkdir(foreign);
    await mkdir(bin);
    await writeFile(foreignGit, await readFile(join(import.meta.dirname, "shim", "git"), "utf8"));
    await chmod(foreignGit, 0o755);
    await writeFile(git, "#!/bin/sh\nexit 0\n");
    await chmod(git, 0o755);

    const context = {
      command: "git status",
      cwd: root,
      env: { PATH: `${foreign}:${bin}` },
    };
    const result = runHook(context, join(root, "tasks"));

    expect(result.env.AGENT_KIT_REAL_GIT).toBe(realpathSync(git));
    expect(result.env.AGENT_KIT_REAL_GIT).not.toBe(foreignGit);
    expect(result.env.PATH).toBe(`${SHIM_DIR}:${context.env.PATH}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("armGitShim passes through when git cannot be resolved", () => {
  const context = {
    command: "git status",
    cwd: homedir(),
    env: { PATH: "" },
  };

  expect(runHook(context, join(homedir(), ".cache", "tasks"))).toEqual(context);
});
