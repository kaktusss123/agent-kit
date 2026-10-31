/**
 * current-task projection tests (ZAVOD-5 selection contract) against REAL
 * temporary git repositories: managed-cwd selection, session-branch
 * selection, latest-successful-ensure wins, none/missing states, multi-repo
 * and lanes, detached HEAD, staged/unstaged separation with untracked
 * paths, failed Git reads, and owner matching.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
  SESSION_SELECTION_ENTRY_TYPE,
  buildCurrentTaskProjection,
  isRecordableEnsureStatus,
  readWorkspaceRepos,
  matchActiveOwners,
  type CurrentRepo,
  type CurrentTaskProjection,
  type OwnersFor,
  type SessionSelectionEntry,
} from "./current";
import { linkedWorktreeFacts, taskWorkspacePath } from "./git";
import { ensureTaskRepo } from "./flows";
import { SessionManager } from "@earendil-works/pi-coding-agent";

let rootDir: string | null = null;

function tempDir(prefix: string): string {
  rootDir ??= mkdtempSync(join(tmpdir(), "current-projection-"));
  const dir = join(rootDir, prefix + "-" + Math.random().toString(36).slice(2, 8));
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterAll(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
});

function sh(cwd: string, ...cmd: string[]): string {
  return execFileSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf8" }).trim();
}

/** Local-only source repo with one commit on main and a task branch. */
function makeSourceRepo(name: string): { source: string; taskRoot: string; branch: string } {
  const base = tempDir(name);
  const source = join(base, "src");
  const taskRoot = join(base, "tasks");
  mkdirSync(source, { recursive: true });
  mkdirSync(taskRoot, { recursive: true });
  sh(source, "git", "init", "-q", "-b", "main");
  sh(source, "git", "config", "user.email", "test@example.invalid");
  sh(source, "git", "config", "user.name", "Test");
  writeFileSync(join(source, "README.md"), "init\n");
  sh(source, "git", "add", "-A");
  sh(source, "git", "commit", "-qm", "init");
  // Task branch stays FREE (primary remains on main) so ensure_task_repo
  // can attach it into a managed worktree.
  sh(source, "git", "branch", "feat/work");
  return { source, taskRoot, branch: "feat/work" };
}

async function ensure(source: string, taskRoot: string, params?: Record<string, unknown>) {
  const result = (await ensureTaskRepo(
    { branch: (params?.branch as string | undefined) ?? "feat/work", source_path: source, ...params } as never,
    source,
    { taskRoot },
  )) as { status: string; task: string; worktree: string };
  expect(result.status).toBe("attached");
  return result;
}

const ws = (taskRoot: string, task: string): string => taskWorkspacePath(task, taskRoot);

function selectionEntry(task: string, worktree: string): SessionSelectionEntry {
  return { type: "custom", customType: SESSION_SELECTION_ENTRY_TYPE, data: { task, worktree } };
}

function compactionEntry(): SessionSelectionEntry {
  return { type: "compaction", customType: undefined, data: undefined };
}

function noOwners(): OwnersFor {
  return () => [];
}

async function project(opts: {
  cwd: string;
  taskRoot: string;
  entries?: SessionSelectionEntry[];
  owners?: OwnersFor;
}): Promise<CurrentTaskProjection> {
  return buildCurrentTaskProjection({
    cwd: opts.cwd,
    taskRoot: opts.taskRoot,
    branchEntries: opts.entries ?? [],
    owners: opts.owners ?? noOwners(),
  });
}

function byName(projection: CurrentTaskProjection): Map<string, CurrentRepo> {
  return new Map(projection.repos.map((r) => [r.name, r]));
}

describe("current-task projection: selection", () => {
  test("managed session cwd selects its workspace (source cwd), nested dirs included", async () => {
    const { source, taskRoot } = makeSourceRepo("cwd-managed");
    const ensured = await ensure(source, taskRoot);
    mkdirSync(join(ensured.worktree, "packages", "deep"), { recursive: true });

    const projection = await project({ cwd: ensured.worktree, taskRoot });
    expect(projection.state).toBe("ok");
    expect(projection.source).toBe("cwd");
    expect(projection.identity).toBe("feat/work");
    expect(projection.workspace).toBe(ws(taskRoot, "feat/work"));
    expect(projection.repos).toHaveLength(1);

    const nested = await project({ cwd: join(ensured.worktree, "packages", "deep"), taskRoot });
    expect(nested).toMatchObject({ state: "ok", identity: "feat/work", source: "cwd" });
  });

  test("neutral cwd + session selection entry selects the ensured task (source session)", async () => {
    const { source, taskRoot } = makeSourceRepo("session-selected");
    const ensured = await ensure(source, taskRoot);
    const neutral = tempDir("neutral");

    const projection = await project({
      cwd: neutral,
      taskRoot,
      entries: [selectionEntry(ensured.task, ensured.worktree)],
    });
    expect(projection.state).toBe("ok");
    expect(projection.source).toBe("session");
    expect(projection.identity).toBe("feat/work");
    expect(projection.workspace).toBe(ws(taskRoot, ensured.task));
    expect(projection.repos).toHaveLength(1);
    expect(projection.repos[0]!.path).toBe(ensured.worktree);
  });

  test("a later successful ensure switches to a distinct task and session branches stay isolated", async () => {
    const sharedRoot = tempDir("latest-shared-root");
    const first = makeSourceRepo("latest-first");
    const second = makeSourceRepo("latest-second");
    const a = await ensure(first.source, sharedRoot);
    sh(second.source, "git", "branch", "feat/other");
    const b = await ensure(second.source, sharedRoot, { branch: "feat/other" });
    expect(a.task).not.toBe(b.task);
    const entriesA = [selectionEntry(a.task, a.worktree), { type: "message" }, compactionEntry()];
    const entriesB = [...entriesA, selectionEntry(b.task, b.worktree)];
    const cwd = tempDir("neutral-latest");
    expect(await project({ cwd, taskRoot: sharedRoot, entries: entriesA })).toMatchObject({ state: "ok", identity: a.task, source: "session" });
    expect(await project({ cwd, taskRoot: sharedRoot, entries: entriesB })).toMatchObject({ state: "ok", identity: b.task, source: "session" });
    // A fork/session with no selection cannot inherit the other branch's entry.
    expect(await project({ cwd, taskRoot: sharedRoot, entries: [] })).toMatchObject({ state: "none", identity: null });
  });

  test("no association is an explicit none even when OTHER host workspaces exist", async () => {
    const unrelated = makeSourceRepo("unrelated-host");
    await ensure(unrelated.source, unrelated.taskRoot);

    const projection = await project({
      cwd: tempDir("neutral-none"),
      taskRoot: unrelated.taskRoot,
      entries: [],
    });
    expect(projection).toEqual({
      state: "none",
      identity: null,
      workspace: null,
      source: null,
      repos: [],
    });
  });

  test("a vanished associated task is missing: identity retained, repos empty", async () => {
    const { source, taskRoot } = makeSourceRepo("vanished");
    const ensured = await ensure(source, taskRoot);
    rmSync(ws(taskRoot, ensured.task), { recursive: true, force: true });

    const projection = await project({
      cwd: tempDir("neutral-vanished"),
      taskRoot,
      entries: [selectionEntry(ensured.task, ensured.worktree)],
    });
    expect(projection.state).toBe("missing");
    expect(projection.identity).toBe("feat/work");
    expect(projection.workspace).toBe(ws(taskRoot, ensured.task));
    expect(projection.source).toBe("session");
    expect(projection.repos).toEqual([]);
  });

  test("a workspace stripped of its worktrees is missing too", async () => {
    const { source, taskRoot } = makeSourceRepo("stripped");
    const ensured = await ensure(source, taskRoot);
    const wsDir = ws(taskRoot, ensured.task);
    for (const entry of readdirSync(wsDir)) {
      rmSync(join(wsDir, entry), { recursive: true, force: true });
    }

    const projection = await project({
      cwd: tempDir("neutral-stripped"),
      taskRoot,
      entries: [selectionEntry(ensured.task, ensured.worktree)],
    });
    expect(projection).toMatchObject({ state: "missing", identity: "feat/work", repos: [] });
  });

  test("real SessionManager history retains legacy association through save, resume, fork and compaction", async () => {
    const { source, taskRoot } = makeSourceRepo("sdk-history");
    const ensured = await ensure(source, taskRoot);
    const neutral = tempDir("sdk-neutral");
    const sessions = tempDir("sdk-sessions");
    const manager = SessionManager.create(neutral, sessions);
    manager.appendMessage({ role: "user", content: "start", timestamp: Date.now() } as never);
    manager.appendMessage({ role: "toolResult", toolCallId: "call-1", toolName: "ensure_task_repo", content: [{ type: "text", text: JSON.stringify({ status: "attached", task: ensured.task }) }], isError: false, timestamp: Date.now() } as never);
    const file = manager.getSessionFile();
    expect(file).toBeTruthy();
    const resumed = SessionManager.open(file!, sessions);
    const projection = (entries: SessionSelectionEntry[]) => project({ cwd: neutral, taskRoot, entries });
    expect(await projection(resumed.getBranch() as SessionSelectionEntry[])).toMatchObject({ state: "ok", identity: "feat/work" });
    const fork = SessionManager.forkFrom(file!, neutral, tempDir("sdk-fork"));
    expect(await projection(fork.getBranch() as SessionSelectionEntry[])).toMatchObject({ state: "ok", identity: "feat/work" });
    const leaf = resumed.getLeafId();
    resumed.appendCompaction("summary", null, 10);
    expect(await projection(resumed.getBranch() as SessionSelectionEntry[])).toMatchObject({ state: "ok", identity: "feat/work" });
    expect(leaf).toBeTruthy();
  });

  test("legacy successful ensure tool results recover current task, but failures do not", async () => {
    const { source, taskRoot } = makeSourceRepo("legacy-history");
    const ensured = await ensure(source, taskRoot);
    const legacy = { type: "message", message: { role: "toolResult", toolName: "ensure_task_repo", isError: false, content: [{ type: "text", text: JSON.stringify({ status: "attached", task: ensured.task }) }] } } as unknown as SessionSelectionEntry;
    expect(await project({ cwd: tempDir("legacy-neutral"), taskRoot, entries: [legacy] })).toMatchObject({ state: "ok", identity: "feat/work", source: "session" });
    const failed = { ...legacy, message: { ...legacy.message, isError: true } } as unknown as SessionSelectionEntry;
    expect(await project({ cwd: tempDir("legacy-failed"), taskRoot, entries: [failed] })).toMatchObject({ state: "none", identity: null });
    const failedStatus = { ...legacy, message: { ...legacy.message, content: [{ type: "text", text: JSON.stringify({ status: "error", task: ensured.task }) }] } } as unknown as SessionSelectionEntry;
    expect(await project({ cwd: tempDir("legacy-status"), taskRoot, entries: [failedStatus] })).toMatchObject({ state: "none", identity: null });
  });

  test("failed ensure statuses are never recordable", () => {
    for (const status of ["error", "branch_in_use", "base_selection_required", undefined, 42]) {
      expect(isRecordableEnsureStatus(status)).toBe(false);
    }
    for (const status of ["reused", "attached", "created_from_remote", "created"]) {
      expect(isRecordableEnsureStatus(status)).toBe(true);
    }
  });
});

describe("current-task projection: repo facts", () => {
  test("multi-repo workspace with a secondary lane keeps canonical identity per repo", async () => {
    const first = makeSourceRepo("multi-a");
    const canonical = await ensure(first.source, first.taskRoot);
    sh(first.source, "git", "branch", "feat/lane-b");
    const lane = (await ensureTaskRepo(
      {
        branch: "feat/lane-b",
        source_path: first.source,
        task: canonical.task,
        slot: "hotfix",
      } as never,
      first.source,
      { taskRoot: first.taskRoot },
    )) as { status: string; worktree: string };
    expect(["created", "attached"]).toContain(lane.status);

    const projection = await project({
      cwd: canonical.worktree,
      taskRoot: first.taskRoot,
      entries: [selectionEntry(lane.task ?? canonical.task, lane.worktree)],
    });
    expect(projection.state).toBe("ok");
    const repos = byName(projection);
    expect(repos.size).toBe(2);
    expect(repos.get("src")).toMatchObject({
      kind: "canonical",
      slot: null,
      classification: "MANAGED_TASK_WORKTREE",
      branch: "feat/work",
      detached: false,
      upstream: null,
      gitAvailable: true,
    });
    expect(repos.get("src__hotfix")).toMatchObject({
      kind: "lane",
      slot: "hotfix",
      classification: "MANAGED_TASK_WORKTREE",
      branch: "feat/lane-b",
      detached: false,
      gitAvailable: true,
    });
    expect(repos.get("src")!.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(repos.get("src__hotfix")!.headSha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("detached HEAD is explicit: detached true, empty branch, sha still read", async () => {
    const { source, taskRoot } = makeSourceRepo("detached");
    const ensured = await ensure(source, taskRoot);
    sh(ensured.worktree, "git", "checkout", "-q", "--detach");

    const projection = await project({
      cwd: tempDir("neutral-detached"),
      taskRoot,
      entries: [selectionEntry(ensured.task, ensured.worktree)],
    });
    expect(projection.state).toBe("ok");
    const repo = projection.repos[0]!;
    expect(repo.detached).toBe(true);
    expect(repo.branch).toBe("");
    expect(repo.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(repo.gitAvailable).toBe(true);
  });

  test("staged and unstaged paths are separate lists; untracked counts as unstaged", async () => {
    const { source, taskRoot } = makeSourceRepo("dirty");
    const ensured = await ensure(source, taskRoot);
    writeFileSync(join(ensured.worktree, "staged.txt"), "staged\n");
    writeFileSync(join(ensured.worktree, "unstaged.txt"), "unstaged\n");
    writeFileSync(join(ensured.worktree, "README.md"), "modified\n");
    sh(ensured.worktree, "git", "add", "staged.txt");

    const projection = await project({
      cwd: tempDir("neutral-dirty"),
      taskRoot,
      entries: [selectionEntry(ensured.task, ensured.worktree)],
    });
    const repo = projection.repos[0]!;
    expect(repo.dirty.available).toBe(true);
    expect(repo.dirty.staged).toEqual(["staged.txt"]);
    expect(repo.dirty.unstaged).toEqual(["README.md", "unstaged.txt"]);
  });

  test("strict workspace inspection ignores ordinary artifacts and inspects linked repositories", async () => {
    const { source, taskRoot } = makeSourceRepo("workspace-artifacts");
    const ensured = await ensure(source, taskRoot);
    const wsDir = ws(taskRoot, ensured.task);
    writeFileSync(join(wsDir, "SPEC.md"), "spec\\n");
    writeFileSync(join(wsDir, "CONTRACT.md"), "contract\\n");
    writeFileSync(join(wsDir, "metadata.json"), "{}\\n");
    writeFileSync(join(wsDir, "notes.txt"), "notes\\n");

    const repos = await readWorkspaceRepos(wsDir);
    expect(repos).toHaveLength(1);
    expect(repos[0]!.path).toBe(ensured.worktree);
    expect(repos[0]!.gitAvailable).toBe(true);
    expect(repos[0]!.headSha).toMatch(/^[0-9a-f]{40}$/);
    const projection = await project({
      cwd: tempDir("workspace-artifacts-cwd"),
      taskRoot,
      entries: [selectionEntry(ensured.task, ensured.worktree)],
    });
    expect(projection.state).toBe("ok");
    expect(projection.repos).toHaveLength(1);
    expect(projection.repos[0]!.path).toBe(ensured.worktree);
  });

  test("strict workspace inspection propagates unreadable .git while legacy catalog skips it", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const { source, taskRoot } = makeSourceRepo("unreadable-git");
    const ensured = await ensure(source, taskRoot);
    const wsDir = ws(taskRoot, ensured.task);
    const gitFile = join(wsDir, "src", ".git");
    // Positive control: the linked-worktree pointer is readable before changing permissions.
    expect(readFileSync(gitFile, "utf-8")).toStartWith("gitdir:");
    chmodSync(gitFile, 0);
    try {
      await expect(readWorkspaceRepos(wsDir)).rejects.toMatchObject({ code: "EACCES" });
      // The non-strict global catalog intentionally retains its historical skip behavior.
      expect(await linkedWorktreeFacts(wsDir)).toEqual([]);
    } finally {
      chmodSync(gitFile, 0o644);
    }
  });

  test("failed Git reads are unavailable, never clean; headSha is null", async () => {
    const { source, taskRoot } = makeSourceRepo("broken");
    const ensured = await ensure(source, taskRoot);
    const wsDir = ws(taskRoot, ensured.task);
    const repoName = "src";
    rmSync(join(wsDir, repoName, ".git"));
    writeFileSync(join(wsDir, repoName, ".git"), "gitdir: /nonexistent/gitdir\n");

    const repos = await readWorkspaceRepos(wsDir);
    expect(repos).toHaveLength(1);
    const repo = repos[0]!;
    expect(repo.gitAvailable).toBe(false);
    expect(repo.headSha).toBeNull();
    expect(repo.branch).toBe("");
    expect(repo.detached).toBe(false);
    expect(repo.dirty).toEqual({ staged: [], unstaged: [], available: false });
    // The projection still reports the workspace as ok — the workspace
    // exists; the REPO facts carry the unavailability.
    const projection = await project({
      cwd: tempDir("neutral-broken"),
      taskRoot,
      entries: [selectionEntry(ensured.task, ensured.worktree)],
    });
    expect(projection.state).toBe("ok");
    expect(projection.repos[0]!.gitAvailable).toBe(false);
  });

  test("owner matcher rejects malformed, terminal, and settled agent records", () => {
    const path = tempDir("owner-target");
    expect(matchActiveOwners([null, {}, { id: 7, label: "bad", run: { workspace: path, state: "running" } },
      { id: "finished", label: "Finished", run: { workspace: path, state: "running", result: { status: "done" } } },
      { id: "settled", label: "Settled", run: { workspace: path, state: "settled" } },
      { id: "live", label: "Live", run: { workspace: path, state: "running" } }], path)).toEqual([
        { id: "live", label: "Live", state: "running" },
      ]);
  });

  test("owners are matched per exact repository workspace path", async () => {
    const first = makeSourceRepo("owners-a");
    const canonical = await ensure(first.source, first.taskRoot);
    sh(first.source, "git", "branch", "feat/lane-b");
    const lane = (await ensureTaskRepo(
      {
        branch: "feat/lane-b",
        source_path: first.source,
        task: canonical.task,
        slot: "dev",
      } as never,
      first.source,
      { taskRoot: first.taskRoot },
    )) as { status: string; worktree: string };

    const seen: string[] = [];
    const owners: OwnersFor = (repoPath) => {
      seen.push(repoPath);
      return repoPath.endsWith("src__dev")
        ? [{ id: "owner-1", label: "lane-owner", state: "running" }]
        : [{ id: "owner-2", label: "main-owner", state: "waiting_input" }];
    };
    const repos = await readWorkspaceRepos(taskWorkspacePath(canonical.task, first.taskRoot), owners);
    expect(seen.sort()).toEqual(
      [canonical.worktree, lane.worktree].sort(),
    );
    const reposByName = new Map(repos.map((r) => [r.name, r]));
    expect(reposByName.get("src")!.owners).toEqual([
      { id: "owner-2", label: "main-owner", state: "waiting_input" },
    ]);
    expect(reposByName.get("src__dev")!.owners).toEqual([
      { id: "owner-1", label: "lane-owner", state: "running" },
    ]);
  });
});
