/**
 * task-workspace core — runtime tool flows.
 *
 * Deterministic mechanics behind task_status / ensure_task_repo /
 * remove_task_lane / checkpoint_commit. Host-independent: no pi SDK
 * imports, no host result representation. Each flow takes plain parameters,
 * the session cwd, and an explicit task root, and returns a plain domain
 * result object; the host binding owns schemas, serialization, result
 * attachment (e.g. details), and error catching.
 */
import { basename, dirname, join, relative, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import {
  classifyPath,
  expandPath,
  findGitRoot,
  getInputRepoFacts,
  getLaneFacts,
  getRepoBranch,
  getRepoCommonDir,
  getRepoSha,
  getSourceDirty,
  getUpstream,
  git,
  getWorktreeList,
  isLinkedWorktree,
  laneIdentity,
  parseLaneName,
  parseWorktreePaths,
  realpath,
  scanTaskWorkspaces,
  taskWorkspacePath,
} from "./git";
import { bootstrapWorktreeDependencies } from "./bootstrap";
import type { BootstrapConfig } from "./bootstrap";
import { isSecretPath } from "./guard";
import type { BootstrapResult, DirtyState, LinkedWorktreeFact } from "./types";

const DEFERRED_PASS_RESULTS: Record<string, true> = {
  pass: true,
  passed: true,
  ok: true,
  success: true,
  successful: true,
  true: true,
  yes: true,
};

/** Default development branches can never be task branches (canonical or
 *  lane): task work must land on its own reviewable branch. Exact names
 *  only — "release/main" or "develop-2" stay ordinary task branches. */
const PROTECTED_TASK_BRANCHES = new Set(["main", "master", "develop"]);

/** Worktree dependency provisioning (F013: a fresh managed worktree of a
 *  manifest-free extension repo must be test-capable with no manual steps).
 *  The binding supplies the package configuration and the environment; the
 *  worktree is the only thing touched, the source/primary checkout never
 *  is. Absent → results carry no bootstrap field (provisioning off). */
export interface EnsureBootstrap {
  config: BootstrapConfig;
  env: Record<string, string | undefined>;
}

async function withBootstrap<T extends { status: string }>(
  result: T,
  worktree: string,
  bootstrap?: EnsureBootstrap,
): Promise<T & { bootstrap?: BootstrapResult }> {
  if (!bootstrap) return { ...result };
  return {
    ...result,
    bootstrap: await bootstrapWorktreeDependencies(worktree, bootstrap.config, {
      env: bootstrap.env,
      primaryDir: await getRepoCommonDir(worktree),
    }),
  };
}

// ─── task_status ────────────────────────────────────────────────────────

export async function taskStatus(
  params: { path?: string },
  ctxCwd: string,
  opts: { taskRoot: string },
) {
  const cwd = realpath(ctxCwd);
  const targetPath = params.path ? expandPath(params.path, cwd) : cwd;
  const classification = classifyPath(targetPath, cwd, opts.taskRoot);

  let repoRoot = "";
  let branch = "";
  let isLinked = false;
  if (classification !== "OUTSIDE_GIT") {
    const abs = expandPath(targetPath, cwd);
    const root = findGitRoot(abs);
    if (root) {
      repoRoot = root;
      branch = await getRepoBranch(root);
      isLinked = isLinkedWorktree(root);
    }
  }

  const taskWorkspaces = await scanTaskWorkspaces(opts.taskRoot);

  const result = {
    classification,
    cwd: targetPath,
    repoRoot,
    branch,
    isLinkedWorktree: isLinked,
    taskRoot: opts.taskRoot,
    taskWorkspaces,
  };

  return result;
}

// ─── ensure_task_repo ───────────────────────────────────────────────────

export interface EnsureTaskRepoParams {
  branch: string;
  source_path: string;
  base_ref?: string;
  remote?: string;
  task?: string;
  slot?: string;
}

export async function ensureTaskRepo(
  params: EnsureTaskRepoParams,
  ctxCwd: string,
  opts: { taskRoot: string; bootstrap?: EnsureBootstrap },
) {
  // 0. Protected branches: refuse before anything is created or changed.
  if (PROTECTED_TASK_BRANCHES.has(params.branch)) {
    return {
      status: "error",
      message: `Refusing ${params.branch} as a task branch: ${[...PROTECTED_TASK_BRANCHES].join(", ")} are default development branches, not task branches. Ask the user or derive a proper task branch name.`,
    };
  }

  // 1. Resolve source repo (canonicalize cwd to avoid symlink mismatches)
  const cwd = realpath(ctxCwd);
  const sourceAbs = expandPath(params.source_path, cwd);
  const srcRoot = await git(sourceAbs, "rev-parse", "--show-toplevel");
  if (!srcRoot.ok) {
    return {
      status: "error",
      message: `Not a git repository: ${params.source_path}`,
    };
  }
  const sourceRoot = srcRoot.stdout;

  // 2. Workspace + target path. Canonical call: workspace identity is the
  // branch, target dir is the repo basename. Lane call: same canonical
  // workspace (identity from `task`), sibling dir <repo>__<slot>, and the
  // lane's own `branch`/base — no second task workspace, no manifest.
  if (params.slot && !params.task) {
    return {
      status: "error",
      message:
        "slot requires task (the canonical workspace identity) so the lane lands inside the existing task workspace",
    };
  }
  if (
    params.slot &&
    (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(params.slot) ||
      params.slot.includes("__"))
  ) {
    return {
      status: "error",
      message: "slot must match [A-Za-z0-9][A-Za-z0-9._-]* and must not contain __",
    };
  }
  const identity = params.slot ? params.task : params.branch;
  if (identity === undefined) {
    return {
      status: "error",
      message: "Task identity is required: pass branch, or slot together with task",
    };
  }
  const ws = taskWorkspacePath(identity, opts.taskRoot);
  const target = params.slot
    ? join(ws, `${basename(sourceRoot)}__${params.slot}`)
    : join(ws, basename(sourceRoot));

  // 3. Check if target exists but is not a worktree of source
  if (existsSync(target)) {
    const gDir = findGitRoot(target);
    if (gDir) {
      const wtList = await git(sourceRoot, "worktree", "list", "--porcelain");
      if (wtList.ok) {
        const resolvedTarget = realpath(target);
        const isWorktreeOfSource = wtList.stdout
          .split("\n")
          .some(
            (line) =>
              line.startsWith("worktree ") &&
              realpath(line.slice("worktree ".length)) === resolvedTarget,
          );
        if (!isWorktreeOfSource) {
          return {
            status: "error",
            message: `Target exists at ${target} but is not a worktree of ${sourceRoot}`,
          };
        }
      }
    }
  }

  // 4. Check if target is already managed by source repo
  const wtList = await git(sourceRoot, "worktree", "list", "--porcelain");
  if (wtList.ok) {
    const lines = wtList.stdout.split("\n");
    let currentPath = "";
    let currentBranch = "";
    const resolvedTarget = realpath(target);
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        if (realpath(currentPath) === resolvedTarget) break;
        currentPath = line.slice("worktree ".length);
        currentBranch = "";
      } else if (line.startsWith("branch ")) {
        currentBranch = line
          .slice("branch ".length)
          .replace("refs/heads/", "");
      }
    }
    if (realpath(currentPath) === resolvedTarget) {
      if (currentBranch === params.branch) {
        const inputRepo = await getInputRepoFacts(sourceAbs, sourceRoot, cwd, opts.taskRoot);
        const headSha = await getRepoSha(target);
        const upstream = await getUpstream(sourceRoot, params.branch);
        return await withBootstrap({
          status: "reused",
          task: identity,
          worktree: target,
          kind: params.slot ? "lane" : "canonical",
          slot: params.slot ?? null,
          branch: params.branch,
          branchSource: "local",
          upstream,
          base: null,
          inputRepo,
          headSha,
        }, target, opts.bootstrap);
      }
      return {
        status: "error",
        message: `Worktree exists at ${target} but on branch ${currentBranch}, not ${params.branch}`,
      };
    }
  }

  // 5. A local task branch needs no remote selection or network access.
  const localRef = await git(
    sourceRoot,
    "show-ref",
    "--verify",
    `refs/heads/${params.branch}`,
  );
  if (localRef.ok) {
    // Local branch exists — check if it's checked out elsewhere
    const allWt = await git(sourceRoot, "worktree", "list", "--porcelain");
    if (allWt.ok) {
      const wtLines = allWt.stdout.split("\n");
      let wtPath = "";
      let wtBranch = "";
      for (const line of wtLines) {
        if (line.startsWith("worktree ")) {
          if (wtBranch === params.branch && realpath(wtPath) !== realpath(target)) {
            return {
              status: "branch_in_use",
              worktree: wtPath,
            };
          }
          wtPath = line.slice("worktree ".length);
          wtBranch = "";
        } else if (line.startsWith("branch ")) {
          wtBranch = line
            .slice("branch ".length)
            .replace("refs/heads/", "");
        }
      }
      if (wtBranch === params.branch && realpath(wtPath) !== realpath(target)) {
        return {
          status: "branch_in_use",
          worktree: wtPath,
        };
      }
    }

    // Branch is free — create worktree
    await mkdir(ws, { recursive: true });
    const add = await git(
      sourceRoot,
      "worktree",
      "add",
      target,
      params.branch,
    );
    if (!add.ok) {
      return {
        status: "error",
        message: `Failed to create worktree: ${add.stderr}`,
      };
    }
    const inputRepo = await getInputRepoFacts(sourceAbs, sourceRoot, cwd, opts.taskRoot);
    const headSha = await getRepoSha(target);
    const upstream = await getUpstream(sourceRoot, params.branch);
    return await withBootstrap({
      status: "attached",
      task: identity,
      worktree: target,
      kind: params.slot ? "lane" : "canonical",
      slot: params.slot ?? null,
      branch: params.branch,
      branchSource: "local",
      upstream,
      base: null,
      inputRepo,
      headSha,
    }, target, opts.bootstrap);
  }

  // 6. The task branch is absent. Resolve and validate a remote only now;
  // local-only repositories can create directly from an explicit local base.
  const remoteList = await git(sourceRoot, "remote");
  if (!remoteList.ok) {
    return {
      status: "error",
      message: `Failed to list configured remotes: ${remoteList.stderr.trim()}`,
    };
  }
  const remotes = remoteList.stdout.split("\n").filter((r) => r);
  let remote: string | undefined;
  if (params.remote) {
    if (!remotes.includes(params.remote)) {
      return {
        status: "error",
        message: `Unknown remote ${params.remote}; configured remotes: ${remotes.length > 0 ? remotes.join(", ") : "none"}`,
      };
    }
    remote = params.remote;
  } else if (remotes.includes("origin")) {
    remote = "origin";
  } else if (remotes.length === 1) {
    remote = remotes[0];
  } else if (remotes.length > 1) {
    return {
      status: "remote_selection_required",
      remotes,
    };
  } else if (!params.base_ref) {
    return {
      status: "base_selection_required",
      reason:
        "The task branch is absent and the source repository has no remotes; pass an explicit local base_ref.",
      remotes: [],
    };
  }

  // 6b. With a remote, perform one required successful fetch, then resolve
  // against refreshed refs. Fail closed on fetch failure: stale remote refs
  // never materialize a task branch.
  if (remote) {
    const fetchRes = await git(
      sourceRoot,
      "fetch",
      "--prune",
      "--no-prune-tags",
      remote,
    );
    if (!fetchRes.ok) {
      return {
        status: "error",
        message: `Fetch of ${remote} failed; refusing to create task branch from stale refs: ${fetchRes.stderr.trim()}`,
      };
    }
    const remoteRef = await git(
      sourceRoot,
      "show-ref",
      "--verify",
      `refs/remotes/${remote}/${params.branch}`,
    );
    if (remoteRef.ok) {
      const remoteSha = remoteRef.stdout.split(/\s+/)[0];
      await mkdir(ws, { recursive: true });
      const add = await git(
        sourceRoot,
        "worktree",
        "add",
        "--track",
        "-b",
        params.branch,
        target,
        `${remote}/${params.branch}`,
      );
      if (!add.ok) {
        return {
          status: "error",
          message: `Failed to create worktree from remote: ${add.stderr}`,
        };
      }
      const inputRepo = await getInputRepoFacts(sourceAbs, sourceRoot, cwd, opts.taskRoot);
      const headSha = await getRepoSha(target);
      return await withBootstrap({
        status: "created_from_remote",
        task: identity,
        worktree: target,
        kind: params.slot ? "lane" : "canonical",
        slot: params.slot ?? null,
        branch: params.branch,
        branchSource: "remote",
        upstream: `${remote}/${params.branch}`,
        remoteSha,
        base: null,
        inputRepo,
        headSha,
      }, target, opts.bootstrap);
    }
  }

  // 6c. The task branch is absent locally and on the selected remote, or the
  // repository is local-only — resolve the requested/default base.
  let baseSha: string;
  let baseRef: string;

  if (params.base_ref) {
    const baseRes = await git(sourceRoot, "rev-parse", params.base_ref);
    if (!baseRes.ok) {
      return {
        status: "error",
        message: `Invalid base ref: ${params.base_ref}`,
      };
    }
    baseSha = baseRes.stdout;
    baseRef = params.base_ref;
  } else {
    // No explicit base reaches this branch only when a remote was selected.
    // Refs were already refreshed by the required fetch in 6b; base selection
    // must not trigger a second fetch for the same decision.
    if (!remote) {
      return {
        status: "base_selection_required",
        reason:
          "The task branch is absent and the source repository has no remotes; pass an explicit local base_ref.",
        remotes: [],
      };
    }
    // Determine remote default branch
    const symRef = await git(
      sourceRoot,
      "symbolic-ref",
      `refs/remotes/${remote}/HEAD`,
    );
    let remoteDefault = "";
    if (symRef.ok) {
      remoteDefault = symRef.stdout.replace(
        `refs/remotes/${remote}/`,
        "",
      );
    } else {
      // Fallback: git remote show
      const show = await git(sourceRoot, "remote", "show", remote);
      const m = show.stdout.match(/HEAD branch:\s*(\S+)/);
      if (m) remoteDefault = m[1];
    }

    if (!remoteDefault) {
      return {
        status: "error",
        message: `Cannot determine remote default branch for ${remote}`,
      };
    }

    const devRef = await git(
      sourceRoot,
      "show-ref",
      "--verify",
      `refs/remotes/${remote}/develop`,
    );
    if (remoteDefault !== "develop" && devRef.ok) {
      return {
        status: "base_selection_required",
        remoteDefault,
        developExists: true,
      };
    }

    const baseBranch = `${remote}/${remoteDefault}`;
    const baseRes = await git(sourceRoot, "rev-parse", baseBranch);
    if (!baseRes.ok) {
      return {
        status: "error",
        message: `Cannot resolve base branch ${baseBranch}`,
      };
    }
    baseSha = baseRes.stdout;
    baseRef = baseBranch;
  }
  // Create branch from base
  await mkdir(ws, { recursive: true });
  const add = await git(
    sourceRoot,
    "worktree",
    "add",
    "-b",
    params.branch,
    target,
    baseSha,
  );
  if (!add.ok) {
    return {
      status: "error",
      message: `Failed to create worktree with branch: ${add.stderr}`,
    };
  }
  const inputRepo = await getInputRepoFacts(sourceAbs, sourceRoot, cwd, opts.taskRoot);
  const headSha = await getRepoSha(target);
  return await withBootstrap({
    status: "created",
    task: identity,
    worktree: target,
    kind: params.slot ? "lane" : "canonical",
    slot: params.slot ?? null,
    branch: params.branch,
    branchSource: "base",
    upstream: null,
    base: { ref: baseRef, sha: baseSha },
    inputRepo,
    headSha,
  }, target, opts.bootstrap);
}

// ─── remove_task_lane ───────────────────────────────────────────────────

export async function removeTaskLane(
  params: { task: string; path: string },
  ctxCwd: string,
  opts: { taskRoot: string },
) {
  const cwd = realpath(ctxCwd);
  const target = realpath(expandPath(params.path, cwd));
  const workspace = realpath(taskWorkspacePath(params.task, opts.taskRoot));
  const relativeTarget = relative(workspace, target);
  const laneName = basename(target);
  const parsedLane = parseLaneName(laneName);
  const isDirectChild =
    relativeTarget.length > 0 &&
    !relativeTarget.startsWith("..") &&
    !relativeTarget.includes("/") &&
    resolve(workspace, relativeTarget) === target;

  if (!isDirectChild || !parsedLane) {
    return {
      status: "lane_rejected",
      task: params.task,
      path: target,
      reason:
        "Only a secondary lane directly inside the requested managed task workspace can be removed.",
    };
  }

  const repo = parsedLane.repo;
  const slot = parsedLane.slot;
  const root = findGitRoot(target);
  const classification = classifyPath(target, cwd, opts.taskRoot);
  const canonicalPath = join(workspace, repo);
  const linked = new Map<string, LinkedWorktreeFact>();
  if (
    classification === "MANAGED_TASK_WORKTREE" &&
    root === target &&
    isLinkedWorktree(target)
  ) {
    linked.set(laneName, {
      path: target,
      commonDir: await getRepoCommonDir(target),
    });
  }
  if (
    existsSync(canonicalPath) &&
    findGitRoot(canonicalPath) === canonicalPath &&
    isLinkedWorktree(canonicalPath)
  ) {
    linked.set(repo, {
      path: canonicalPath,
      commonDir: await getRepoCommonDir(canonicalPath),
    });
  }
  const identity = laneIdentity(laneName, linked);
  if (
    classification !== "MANAGED_TASK_WORKTREE" ||
    root !== target ||
    identity.kind !== "lane"
  ) {
    return {
      status: "lane_rejected",
      task: params.task,
      repo,
      slot,
      path: target,
      classification,
      reason:
        "The target is not a managed linked secondary lane with a canonical sibling.",
    };
  }

  const facts = await getLaneFacts(params.task, target, slot, repo);
  if (!facts.branch) {
    return {
      status: "lane_rejected",
      ...facts,
      reason: "A secondary lane must have an attached local branch.",
    };
  }
  if (facts.dirty.staged.length > 0 || facts.dirty.unstaged.length > 0) {
    return {
      status: "lane_dirty",
      ...facts,
      reason:
        "Refusing to remove a dirty lane; inspect or commit its changes first.",
    };
  }

  const worktrees = await git(target, "worktree", "list", "--porcelain");
  const controlPath = worktrees.ok
    ? parseWorktreePaths(worktrees.stdout).find(
        (path) => realpath(path) !== target,
      )
    : undefined;
  if (!controlPath) {
    return {
      status: "lane_rejected",
      ...facts,
      reason:
        "Cannot find another worktree from which to perform safe lane cleanup.",
    };
  }

  const remove = await git(controlPath, "worktree", "remove", target);
  if (!remove.ok) {
    return {
      status: "worktree_remove_failed",
      ...facts,
      reason: remove.stderr,
    };
  }

  const deleteBranch = await git(controlPath, "branch", "-d", facts.branch);
  if (!deleteBranch.ok) {
    return {
      status: "branch_delete_blocked",
      ...facts,
      reason:
        `Worktree removed, but safe branch deletion was refused: ${deleteBranch.stderr}. The branch was not force-deleted.`,
    };
  }

  return {
    status: "removed",
    ...facts,
  };
}

// ─── teardown_task_repo ──────────────────────────────────────────────

interface TeardownWorktreeFact {
  name: string;
  path: string;
  branch: string;
  headSha: string;
  upstream: string | null;
  commonDir: string;
  dirty: DirtyState;
}

interface TeardownRepoGroup {
  commonDir: string;
  worktrees: TeardownWorktreeFact[];
}

/** Enumerate the linked worktrees directly inside a task workspace and
 *  group them by their git common dir. Returns a refusal result when the
 *  layout is not one ensure_task_repo could have produced (real nested
 *  repositories, unexpected directories, or a common dir inside the
 *  workspace — none of these may be deleted by a runtime flow). */
async function collectTeardownFacts(
  workspace: string,
): Promise<{ ok: true; groups: Map<string, TeardownRepoGroup>; artifacts: string[] } | { ok: false; refusal: Record<string, unknown> }> {
  const groups = new Map<string, TeardownRepoGroup>();
  const artifacts: string[] = [];
  const unexpected: string[] = [];
  const nestedRepos: string[] = [];
  const badCommon: string[] = [];
  for (const entry of readdirSync(workspace, { withFileTypes: true })) {
    const child = join(workspace, entry.name);
    if (!entry.isDirectory()) {
      artifacts.push(entry.name);
      continue;
    }
    let linked = false;
    try {
      linked = readFileSync(join(child, ".git"), "utf-8").startsWith("gitdir:");
    } catch {
      linked = false;
    }
    if (!linked) {
      if (existsSync(join(child, ".git"))) nestedRepos.push(entry.name);
      else unexpected.push(entry.name);
      continue;
    }
    const branch = await getRepoBranch(child);
    const commonDir = await getRepoCommonDir(child);
    if (!branch || !commonDir) {
      unexpected.push(entry.name);
      continue;
    }
    if (commonDir === workspace || commonDir.startsWith(workspace + "/")) {
      badCommon.push(entry.name);
      continue;
    }
    const group = groups.get(commonDir) ?? { commonDir, worktrees: [] };
    group.worktrees.push({
      name: entry.name,
      path: child,
      branch,
      headSha: await getRepoSha(child),
      upstream: await getUpstream(child, branch),
      commonDir,
      dirty: await getSourceDirty(child),
    });
    groups.set(commonDir, group);
  }
  if (nestedRepos.length > 0 || unexpected.length > 0 || badCommon.length > 0) {
    return {
      ok: false,
      refusal: {
        status: "workspace_layout_rejected",
        nestedRepositories: nestedRepos,
        unexpectedDirectories: unexpected,
        commonDirInsideWorkspace: badCommon,
        reason:
          "Refusing teardown: the workspace contains entries ensure_task_repo does not create (a nested real repository, an unexpected directory, or a git common dir inside the workspace). Inspect and clean them manually; the runtime never deletes what it did not create.",
      },
    };
  }
  return { ok: true, groups, artifacts };
}

export async function teardownTaskRepo(
  params: { task: string },
  ctxCwd: string,
  opts: { taskRoot: string },
) {
  // 0. Resolve the workspace: the task identity maps to a directory that
  // must be a DIRECT child of the task root — never the root itself, never
  // outside it (identity traversal like ".." or "a/../../b" resolves to an
  // escape and is refused before anything is inspected).
  if (!params.task.trim()) {
    return { status: "error", message: "Task identity is required." };
  }
  const taskRoot = realpath(opts.taskRoot);
  const workspace = realpath(taskWorkspacePath(params.task, taskRoot));
  if (dirname(workspace) !== taskRoot || workspace === taskRoot) {
    return {
      status: "error",
      message: `Refusing task identity ${JSON.stringify(params.task)}: it does not resolve to a workspace directly inside ${taskRoot}`,
    };
  }
  if (!existsSync(workspace)) {
    return {
      status: "error",
      message: `No task workspace for ${JSON.stringify(params.task)} under ${taskRoot}; run task_status to list existing workspaces`,
    };
  }

  // 1. Inventory: all linked worktrees grouped per repo, plus artifact files.
  const inventory = await collectTeardownFacts(workspace);
  if (!inventory.ok) return inventory.refusal;
  const { groups, artifacts } = inventory;
  const allWorktrees = [...groups.values()].flatMap((g) => g.worktrees);

  // 2. Dirty guard: no worktree with uncommitted changes is ever removed.
  const dirty = allWorktrees.filter(
    (w) => w.dirty.staged.length > 0 || w.dirty.unstaged.length > 0,
  );
  if (dirty.length > 0) {
    return {
      status: "task_dirty",
      task: params.task,
      workspace,
      dirty: dirty.map((w) => ({
        name: w.name,
        path: w.path,
        branch: w.branch,
        staged: w.dirty.staged,
        unstaged: w.dirty.unstaged,
      })),
      reason:
        "Refusing teardown: a worktree in this task workspace has uncommitted changes. Commit, discard, or move them first; nothing was removed.",
    };
  }

  // 3. branch_in_use guard: a task branch checked out in a worktree OUTSIDE
  // this workspace (typically another session's) must produce a clear
  // refusal — never a silent removal path.
  const inUse: { branch: string; worktree: string }[] = [];
  for (const group of groups.values()) {
    const list = await getWorktreeList(group.commonDir);
    if (list.length === 0) {
      return {
        status: "error",
        message: `Cannot read the worktree registry of ${group.commonDir}; refusing to tear down without it`,
      };
    }
    const ourPaths = new Set(group.worktrees.map((w) => realpath(w.path)));
    for (const entry of list) {
      if (!entry.branch) continue;
      if (ourPaths.has(realpath(entry.path))) continue;
      if (group.worktrees.some((w) => w.branch === entry.branch)) {
        inUse.push({ branch: entry.branch, worktree: entry.path });
      }
    }
  }
  if (inUse.length > 0) {
    return {
      status: "branch_in_use",
      task: params.task,
      workspace,
      branches: inUse,
      reason:
        "Refusing teardown: a task branch is checked out in a worktree outside this task workspace (possibly another session). Coordinate and detach or remove that worktree first; nothing was removed.",
    };
  }

  // 4. Non-force merge guard: every task branch must already be contained
  // in its upstream (when set) or in the common repo's HEAD — the same
  // condition a non-force `git branch -d` enforces. Refuse up front so a
  // refusal never leaves a partially torn-down workspace behind.
  const unmerged: { repo: string; branch: string; target: string | null }[] = [];
  for (const group of groups.values()) {
    const head = await git(group.commonDir, "rev-parse", "HEAD");
    for (const w of group.worktrees) {
      const target = w.upstream ?? (head.ok ? head.stdout : null);
      const merged = target
        ? await git(group.commonDir, "merge-base", "--is-ancestor", w.branch, target)
        : { ok: false };
      if (!merged.ok) {
        unmerged.push({ repo: group.commonDir, branch: w.branch, target });
      }
    }
  }
  if (unmerged.length > 0) {
    return {
      status: "branch_unmerged",
      task: params.task,
      workspace,
      branches: unmerged,
      reason:
        "Refusing teardown: a task branch has commits not contained in its upstream or base HEAD. Push, merge, or delete the branch explicitly; teardown is non-force and nothing was removed.",
    };
  }

  // 5. Execute per repo: remove that repo's worktrees (non-force), then
  // delete its branches (non-force), then prune stale registrations.
  const tornDown: {
    repo: string;
    worktrees: { name: string; path: string; branch: string; headSha: string }[];
    branches: string[];
  }[] = [];
  for (const group of groups.values()) {
    for (const w of group.worktrees) {
      const remove = await git(group.commonDir, "worktree", "remove", w.path);
      if (!remove.ok) {
        return {
          status: "worktree_remove_failed",
          task: params.task,
          workspace,
          repo: group.commonDir,
          name: w.name,
          path: w.path,
          reason: remove.stderr,
          note:
            "Partial teardown: earlier worktrees were already removed and the workspace directory was kept. Fix the cause and rerun teardown_task_repo.",
        };
      }
    }
    const deletedBranches: string[] = [];
    for (const w of group.worktrees) {
      const del = await git(group.commonDir, "branch", "-d", w.branch);
      if (!del.ok) {
        return {
          status: "branch_delete_blocked",
          task: params.task,
          workspace,
          repo: group.commonDir,
          branch: w.branch,
          deletedBranches,
          reason: del.stderr,
          note:
            "Partial teardown: the branch was not force-deleted and the workspace directory was kept. Inspect, then rerun teardown_task_repo.",
        };
      }
      deletedBranches.push(w.branch);
    }
    await git(group.commonDir, "worktree", "prune");
    tornDown.push({
      repo: group.commonDir,
      worktrees: group.worktrees.map((w) => ({
        name: w.name,
        path: w.path,
        branch: w.branch,
        headSha: w.headSha,
      })),
      branches: deletedBranches,
    });
  }

  // 6. Clean the task root metadata directory — every guard has passed and
  // every worktree is unregistered, so only artifact files remain inside.
  rmSync(workspace, { recursive: true, force: true });

  return {
    status: "torn_down",
    task: params.task,
    workspace,
    repos: tornDown,
    artifacts,
  };
}

// ─── checkpoint_commit ──────────────────────────────────────────────────

/** The created commit's file set as Git reports it (empty for an unreadable
 *  state, which the comparison below then fails closed on). The exact SHA is
 *  passed in, never HEAD: the postcondition must be bound to the immutable
 *  commit being reported, even if the worktree moves on. */
async function commitFiles(repoRoot: string, commitSha: string): Promise<string[]> {
  const r = await git(
    repoRoot,
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    "--root",
    // A merge commit has two parents; its own change set is the diff
    // against the first parent. Without this Git prints nothing for merges
    // (verified on git 2.47) and the scope postcondition would reject a
    // legitimate merge.
    "--diff-merges=first-parent",
    commitSha,
  );
  return r.ok ? r.stdout.split("\n").filter((f) => f) : [];
}

/** Postcondition for every successful commit: the created commit's file set
 *  must equal the intended paths. Pre-commit hooks may adjust the index they
 *  run against and Git commits that adjusted index (verified on git 2.47:
 *  even `commit --only` picks up hook-staged files), so the scope can only
 *  be proven after the commit exists — read from the exact reported SHA.
 *  Fail closed: report the fact; the model decides the repair — no automatic
 *  history rewrite. Returns the mismatch result, or null when exact. */
async function commitScopeResult(
  repoRoot: string,
  commitSha: string,
  intended: string[],
): Promise<
  | null
  | {
      status: "commit_scope_mismatch";
      commit: string;
      intended: string[];
      actual: string[];
      reason: string;
    }
> {
  const actual = await commitFiles(repoRoot, commitSha);
  const same =
    actual.length === intended.length &&
    [...actual].sort().join("\n") === [...intended].sort().join("\n");
  if (same) return null;
  return {
    status: "commit_scope_mismatch",
    commit: commitSha,
    intended: [...intended].sort(),
    actual: [...actual].sort(),
    reason:
      "The created commit file set differs from the intended path set (typically a pre-commit hook staging extra files or dropping intended ones). The commit exists; inspect it and decide the repair (e.g. revert it). Nothing was rewritten automatically.",
  };
}

export interface DeferredHookEvidence {
  blocker_kind: "external_prerequisite" | "external_availability";
  failed_hook: string;
  failed_step_command: string;
  failure_reason: string;
  staged_tree: string;
  manual_checks: { command: string; result: string }[];
  remaining_gap: string;
}

export async function checkpointCommit(
  params: {
    repo: string;
    paths: string[];
    message: string;
    allow_primary?: boolean;
    deferred_hook?: DeferredHookEvidence;
  },
  ctxCwd: string,
  opts: { taskRoot: string },
) {
  // 1. Classify repo (canonicalize cwd to avoid symlink mismatches)
  const cwd = realpath(ctxCwd);
  const repoAbs = expandPath(params.repo, cwd);
  const classification = classifyPath(repoAbs, cwd, opts.taskRoot);
  const repoRoot = realpath(findGitRoot(repoAbs) ?? repoAbs);

  if (classification === "PRIMARY_CHECKOUT" && !params.allow_primary) {
    return {
      status: "primary_commit_blocked",
      reason: `Refusing to commit to primary checkout ${repoRoot}. Use allow_primary=true or commit to a task worktree instead.`,
    };
  }

  // 2. Verify all paths resolve inside repoRoot
  const offenders: string[] = [];
  const resolvedPaths: string[] = [];
  for (const p of params.paths) {
    // Paths are repo-scoped: relative entries resolve against the repo
    // root, not the session cwd — `repo` may live in another directory.
    const abs = p.startsWith("/") ? p : p.startsWith("~") ? expandPath(p, cwd) : resolve(repoRoot, p);
    const resolved = resolve(abs);
    if (!resolved.startsWith(repoRoot + "/") && resolved !== repoRoot) {
      offenders.push(p);
    } else {
      resolvedPaths.push(resolved);
    }
  }
  if (offenders.length > 0) {
    return {
      status: "path_outside_repo",
      offenders,
    };
  }

  // 3. Secret check
  const secrets: string[] = [];
  for (const p of resolvedPaths) {
    if (isSecretPath(p)) secrets.push(p);
  }
  if (secrets.length > 0) {
    return {
      status: "secret_path_rejected",
      offenders: secrets,
    };
  }

  // 4. Pre-staged check
  const cached = await git(repoRoot, "diff", "--cached", "--name-only");
  if (cached.ok && cached.stdout) {
    const existingStaged = new Set(
      cached.stdout.split("\n").filter((f) => f),
    );
    const intendedSet = new Set(
      resolvedPaths.map((p) => relative(repoRoot, p)),
    );
    // A staged SUBSET is allowed (idempotent retry, partial pre-staging):
    // staging below adds the remaining intended paths, so the commit's file
    // set is still exactly `intended`. Only an outside path is ambiguous —
    // it would silently broaden the commit.
    const different = [...existingStaged].some((f) => !intendedSet.has(f));
    if (different) {
      return {
        status: "ambiguous_staged",
        staged: [...existingStaged],
        intended: [...intendedSet],
      };
    }
  }

  // 5. Stage exactly the intended paths
  const relPaths = resolvedPaths.map((p) => relative(repoRoot, p));
  // -A is defensive: it stages a deleted intended path as a deletion for
  // path states where plain `git add <path>` rejects it. It is not required
  // for the ordinary case — modern Git stages deletions with plain `add` too.
  const stage = await git(repoRoot, "add", "-A", "--", ...relPaths);
  if (!stage.ok) {
    return {
      status: "error",
      message: `Failed to stage files: ${stage.stderr}`,
    };
  }

  // 6. Commit (hooks run normally)
  let commit = await git(repoRoot, "commit", "-m", params.message);

  // 7. Hook-modified retry: some hooks rewrite the files they inspect
  // (formatters, import sorting). Re-stage only the intended paths and
  // retry the normal hooked commit once before any failure handling.
  if (!commit.ok) {
    const diffCheck = await git(repoRoot, "diff", "--name-only");
    if (diffCheck.ok && diffCheck.stdout) {
      const modifiedFiles = new Set(diffCheck.stdout.split("\n"));
      const needsRestage = relPaths.some((p) => modifiedFiles.has(p));
      if (needsRestage) {
        await git(repoRoot, "add", "-A", "--", ...relPaths);
        commit = await git(repoRoot, "commit", "-m", params.message);
      }
    }
  }
  if (!commit.ok) {
    const failureOutput = `${commit.stderr}\n${commit.stdout}`;
    if (!params.deferred_hook) {
      const finalTreeSha = (await git(repoRoot, "write-tree")).stdout.trim();
      return {
        status: "commit_failed",
        stderr: commit.stderr,
        staged_tree: finalTreeSha,
        deferred_hook_hint:
          "If and only if this hook failure is caused by an external prerequisite that cannot be satisfied at this task stage (e.g. an unpublished same-task dependency) — not by a code-validation failure — retry checkpoint_commit with deferred_hook evidence naming the failing step and passing this staged_tree value verbatim.",
      };
    }
    const d = params.deferred_hook;
    // Evidence is bound to the exact final staged tree of the failed
    // attempt (after any hook-induced restage). A tree mismatch means
    // the verified contents are not the contents being committed.
    const finalTreeSha = (await git(repoRoot, "write-tree")).stdout.trim();
    const evidenceTreeMatches =
      finalTreeSha !== "" && d.staged_tree.trim() === finalTreeSha;
    const evidenceMatches =
      d.failed_step_command.trim().length > 0 &&
      failureOutput.includes(d.failed_step_command);
    const checksComplete =
      d.failed_hook.trim().length > 0 &&
      d.failure_reason.trim().length > 0 &&
      d.remaining_gap.trim().length > 0 &&
      d.manual_checks.length > 0 &&
      d.manual_checks.every(
        (c) =>
          c.command.trim().length > 0 &&
          DEFERRED_PASS_RESULTS[c.result.trim().toLowerCase()] === true,
      );
    if (!evidenceTreeMatches || !evidenceMatches || !checksComplete) {
      return {
        status: "deferred_hook_rejected",
        evidenceTreeMatches,
        evidenceMatches,
        checksComplete,
        reason:
          "Deferred hook verification requires a current hook failure, evidence bound to the exact staged tree being committed, and manual checks with machine-readable pass results. Fix the failure or escalate instead of bypassing.",
      };
    }
    const bypass = await git(repoRoot, "commit", "--no-verify", "-m", params.message);
    if (!bypass.ok) {
      return {
        status: "error",
        message: `Deferred hook commit failed: ${bypass.stderr}`,
      };
    }
    const deferredLog = await git(repoRoot, "log", "-1", "--format=%H");
    const deferredScope = await commitScopeResult(repoRoot, deferredLog.stdout, relPaths);
    if (deferredScope) return deferredScope;
    return {
      status: "committed_with_deferred_hook",
      commit: deferredLog.stdout,
      branch: await getRepoBranch(repoRoot),
      files: relPaths,
      failed_hook: d.failed_hook,
      failure_reason: d.failure_reason,
      manual_checks: d.manual_checks,
      remaining_gap: d.remaining_gap,
      note:
        "Do not report this repository fully verified. Re-run the deferred check once the prerequisite is available (a pass closes the gap); surface the gap in any MR or task report.",
    };
  }

  if (!commit.ok) {
    return {
      status: "commit_failed",
      stderr: commit.stderr,
    };
  }

  // 8. Verify: scope postcondition first, then the worktree state.
  const log = await git(repoRoot, "log", "-1", "--format=%H");
  const scopeResult = await commitScopeResult(repoRoot, log.stdout, relPaths);
  if (scopeResult) return scopeResult;
  const status = await git(repoRoot, "status", "--porcelain");
  const branch = await getRepoBranch(repoRoot);
  const remainingDirty = status.ok
    ? status.stdout
      ? status.stdout.split("\n")
      : []
    : [];

  return {
    status: "committed",
    commit: log.stdout,
    branch,
    files: relPaths,
    remainingDirty,
  };
}
