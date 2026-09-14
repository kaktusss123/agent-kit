import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

interface HookContext {
  command: string;
  cwd: string;
  env: Record<string, string>;
}

const INDEX_PATH = join(import.meta.dir, "index.ts");
const SHIM_DIR = join(import.meta.dir, "shim");

function runHook(context: HookContext, taskRoot: string): HookContext {
  const script = `
    import { mock } from "bun:test";
    mock.module("@earendil-works/pi-coding-agent", () => ({ createBashTool: () => ({}) }));
    mock.module("typebox", () => ({ Type: {} }));
    const { armGitShim } = await import(${JSON.stringify(INDEX_PATH)});
    console.log(JSON.stringify(armGitShim(${JSON.stringify(taskRoot)})(${JSON.stringify(context)})));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }),
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

test("armGitShim passes through when git cannot be resolved", () => {
  const context = {
    command: "git status",
    cwd: homedir(),
    env: { PATH: "" },
  };

  expect(runHook(context, join(homedir(), ".cache", "tasks"))).toEqual(context);
});
