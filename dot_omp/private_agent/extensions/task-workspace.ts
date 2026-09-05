/**
 * task-workspace — Deterministic task-workspace runtime.
 *
 * Manages git worktrees for multi-repo task isolation.
 * Branch = task identity. Workspace root = ~/.omp/tasks/<branch_flat>/.
 * All state lives in git (branches + worktrees); no manifest files.
 *
 * Residual limitation (accepted by design): flattening a branch name into the
 * workspace directory name is not injective — distinct branch identities can
 * produce the same directory. No manifest or naming migration exists; resolve
 * a real collision manually if one ever materializes.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { join, basename, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { mkdir, readdir } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";

// Configurable root (env override for tests)
const TASK_ROOT = realpath(process.env.OMP_TASK_ROOT ?? join(homedir(), ".omp", "tasks"));

// ─── Git helpers ────────────────────────────────────────────────────────

async function git(
  cwd: string,
  ...args: string[]
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

// ─── Path classification ────────────────────────────────────────────────

type PathClassification =
  | "OUTSIDE_GIT"
  | "PRIMARY_CHECKOUT"
  | "MANAGED_TASK_WORKTREE"
  | "OTHER_LINKED_WORKTREE";

function expandPath(p: string, cwd: string): string {
  if (p.startsWith("~")) return join(homedir(), p.slice(1));
  if (!p.startsWith("/")) return join(cwd, p);
  return p;
}

function realpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // Path doesn't exist yet — walk up to first existing parent and rejoin
    const parts = p.split("/");
    let existing = "";
    for (const part of parts) {
      if (!part) { existing = "/"; continue; }
      const candidate = existing + part;
      try {
        existing = realpathSync(candidate);
      } catch {
        existing = candidate;
      }
      existing += "/";
    }
    return existing.length > 1 ? existing.slice(0, -1) : "/";
  }
}

function findGitRoot(start: string): string | null {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

function isLinkedWorktree(repoRoot: string): boolean {
  try {
    const content = readFileSync(join(repoRoot, ".git"), "utf-8");
    return content.startsWith("gitdir:");
  } catch {
    return false;
  }
}

function underTaskRoot(p: string): boolean {
  return p.startsWith(TASK_ROOT + "/") || p === TASK_ROOT;
}

function classifyPath(p: string, cwd: string): PathClassification {
  const expanded = expandPath(p, cwd);
  let abs = expanded;
  try {
    abs = realpath(expanded);
  } catch {
    // Target may not exist yet (e.g. a brand-new file); classify the
    // expanded path instead of throwing out of a guard.
  }
  const root = findGitRoot(abs);
  if (!root) return "OUTSIDE_GIT";
  if (underTaskRoot(root)) return "MANAGED_TASK_WORKTREE";
  if (isLinkedWorktree(root)) return "OTHER_LINKED_WORKTREE";
  return "PRIMARY_CHECKOUT";
}

// ─── Git data helpers ───────────────────────────────────────────────────

async function getRepoBranch(repoRoot: string): Promise<string> {
  const r = await git(repoRoot, "branch", "--show-current");
  return r.ok ? r.stdout : "";
}

async function getRepoSha(repoRoot: string): Promise<string> {
  const r = await git(repoRoot, "rev-parse", "HEAD");
  return r.ok ? r.stdout : "";
}
async function getUpstream(repoRoot: string, branch: string): Promise<string | null> {
  const r = await git(
    repoRoot,
    "for-each-ref",
    "--format=%(upstream:short)",
    `refs/heads/${branch}`,
  );
  const out = r.ok ? r.stdout.trim() : "";
  return out || null;
}

async function getSourceDirty(
  sourceRoot: string,
): Promise<{ staged: string[]; unstaged: string[] }> {
  const r = await git(sourceRoot, "status", "--porcelain=v1");
  if (!r.ok) return { staged: [], unstaged: [] };
  const staged: string[] = [];
  const unstaged: string[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const indexStatus = line[0];
    const workStatus = line[1];
    const path = line.slice(3);
    if (indexStatus !== " " && indexStatus !== "?") staged.push(path);
    // Untracked files ("??") are source dirt too — the typical manual-change case.
    if (workStatus !== " ") unstaged.push(path);
  }
  return {
    staged: staged.slice(0, 50),
    unstaged: unstaged.slice(0, 50),
  };
}

// ─── Worktree scanning ──────────────────────────────────────────────────

async function scanTaskWorkspaces(): Promise<
  {
    workspace: string;
    key: string;
    repos: { name: string; path: string; branch: string; headSha: string }[];
    artifacts: string[];
  }[]
> {
  const workspaces: {
    workspace: string;
    key: string;
    repos: { name: string; path: string; branch: string; headSha: string }[];
    artifacts: string[];
  }[] = [];

  let entries: string[];
  try {
    entries = await readdir(TASK_ROOT);
  } catch {
    return workspaces;
  }

  for (const entry of entries) {
    const wsPath = join(TASK_ROOT, entry);

    // Scan subdirectories of the workspace for git worktrees
    let subEntries: string[];
    try {
      subEntries = await readdir(wsPath);
    } catch {
      continue;
    }

    const repos: { name: string; path: string; branch: string; headSha: string }[] = [];
    for (const sub of subEntries) {
      const subPath = join(wsPath, sub);
      // A git worktree has a .git file (not directory) pointing to the main repo
      try {
        const gitContent = readFileSync(join(subPath, ".git"), "utf-8");
        if (!gitContent.startsWith("gitdir:")) continue;
      } catch {
        continue; // not a worktree
      }

      const branchResult = await git(subPath, "branch", "--show-current");
      const branch = branchResult.ok ? branchResult.stdout : "";
      const headResult = await git(subPath, "rev-parse", "HEAD");
      const headSha = headResult.ok ? headResult.stdout : "";

      repos.push({ name: sub, path: subPath, branch, headSha });
    }

    if (repos.length === 0) continue;

    // Scan for model-authored artifacts
    const artifacts: string[] = [];
    try {
      const files = await readdir(wsPath);
      for (const f of files) {
        if (
          f.endsWith(".md") ||
          f.endsWith(".json") ||
          f.endsWith(".txt")
        ) {
          artifacts.push(f);
        }
      }
    } catch {
      // workspace dir may not be readable
    }

    workspaces.push({ workspace: wsPath, key: entry, repos, artifacts });
  }

  return workspaces;
}

// ─── Bash command parsing (best-effort) ─────────────────────────────────

/** Machine-readable pass outcomes accepted as deferred-hook manual check
 *  results. Anything else — failure, skipped, unknown, prose — does not
 *  authorize a --no-verify bypass. */
const DEFERRED_PASS_RESULTS: Record<string, true> = {
  pass: true,
  passed: true,
  ok: true,
  success: true,
  successful: true,
  true: true,
  yes: true,
};

interface ParsedGitInvocation {
  subcommand: string;
  repoRef: string | null; // -C <path> target, or null for the session cwd
  mutating: boolean;
  noVerify: boolean;
}

/** git flags that consume the next token as their value. */
const GIT_VALUE_FLAGS: Record<string, true> = {
  "-C": true,
  "-c": true,
  "--git-dir": true,
  "--work-tree": true,
  "--namespace": true,
  "--super-prefix": true,
};

/** Conservative scan of EVERY `git` invocation in a (possibly compound) shell
 *  command. Not a shell interpreter: a word-boundary `git` starts a candidate
 *  invocation, tokens are split on whitespace and quotes, hard shell
 *  separators (`;`, `&`, `|`, parens, backticks) end one, and ambiguous input
 *  errs toward "mutating" so the guard fails closed. */
function parseGitInvocations(command: string): ParsedGitInvocation[] {
  const invocations: ParsedGitInvocation[] = [];
  const gitWord = /(^|[\s;&|(`])git(?=$|[\s;&|(`])/g;
  let m: RegExpExecArray | null;
  while ((m = gitWord.exec(command)) !== null) {
    const tokens: string[] = [];
    let i = m.index + m[0].length;
    while (i < command.length) {
      while (i < command.length && /\s/.test(command[i])) i++;
      if (i >= command.length) break;
      const ch = command[i];
      if (";&|()`".includes(ch)) break;
      if (ch === '"' || ch === "'") {
        const close = command.indexOf(ch, i + 1);
        const end = close === -1 ? command.length : close + 1;
        tokens.push(command.slice(i, end));
        i = end;
      } else {
        let j = i;
        while (j < command.length && !/[\s;&|()`]/.test(command[j])) j++;
        tokens.push(command.slice(i, j));
        i = j;
      }
    }
    invocations.push(parseGitTokens(tokens));
    // Resume after the consumed invocation so arguments that merely contain
    // the word "git" are not re-parsed as invocations.
    gitWord.lastIndex = i;
  }
  return invocations;
}

/** Internal-URL targets (xd://, local://, skill://, …) are session resources
 *  dispatched by the core router — never filesystem paths. Feeding them
 *  through expandPath/classifyPath silently resolved them against the primary
 *  checkout and made the guard block its own extension tools (field-run F1). */
const INTERNAL_URI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const MUTATING_GIT_SUBCOMMANDS: Record<string, true> = {
  commit: true,
  add: true,
  checkout: true,
  switch: true,
  restore: true,
  reset: true,
  clean: true,
  merge: true,
  rebase: true,
  "cherry-pick": true,
};

function parseGitTokens(tokens: string[]): ParsedGitInvocation {
  const inv: ParsedGitInvocation = {
    subcommand: "",
    repoRef: null,
    mutating: false,
    noVerify: false,
  };
  let i = 0;
  while (i < tokens.length && tokens[i].startsWith("-") && tokens[i] !== "-") {
    const flag = tokens[i];
    if (flag.includes("=")) {
      i++; // attached-value flag (--git-dir=/x)
      continue;
    }
    if (GIT_VALUE_FLAGS[flag] === true) {
      const value = tokens[i + 1];
      if (value === undefined) return inv;
      if (flag === "-C") inv.repoRef = value;
      i += 2;
      continue;
    }
    i++;
  }
  inv.subcommand = tokens[i] ?? "";
  const rest = tokens.slice(i + 1);
  if (inv.subcommand === "worktree") {
    // Read-only introspection is not a mutation (field-run F3); every other
    // worktree subcommand — add/remove/move/prune/lock/unlock/repair or bare
    // usage — stays on the mutating side.
    inv.mutating = !/^(?:list|show)\b/.test(rest.join(" "));
  } else {
    inv.mutating = MUTATING_GIT_SUBCOMMANDS[inv.subcommand] === true;
  }
  inv.noVerify = rest.some((t) => t === "--no-verify");
  return inv;
}

/** Managed worktrees of the SAME repository that a blocked primary-checkout
 *  mutation should be redirected to: all of them when several exist, none
 *  invented when there are none. */
function managedWorktreeHint(root: string): string | null {
  const proc = Bun.spawnSync(["git", "-C", root, "worktree", "list", "--porcelain"]);
  if (proc.exitCode !== 0) return null;
  const managed: string[] = [];
  for (const line of proc.stdout.toString().split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const wt = line.slice("worktree ".length);
    if (underTaskRoot(wt)) managed.push(wt);
  }
  if (managed.length === 0) return null;
  if (managed.length === 1) return managed[0];
  const shown = managed.slice(0, 8).join("\n  ");
  return `\n  ${shown}${managed.length > 8 ? `\n  … (${managed.length} managed worktrees total)` : ""}`;
}

// ─── Secret path detection ──────────────────────────────────────────────

const SECRET_BASENAMES = new Set([
  ".env",
  "credentials.json",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
]);

function isSecretPath(filePath: string): boolean {
  const base = basename(filePath);
  if (SECRET_BASENAMES.has(base)) return true;
  if (base.startsWith(".env.")) return true;
  if (/\.(pem|key)$/.test(base)) return true;
  if (/credentials/.test(base)) return true;
  if (/^secrets\./.test(base)) return true;
  return false;
}

// ─── Extension entry point ──────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  const tb = pi.typebox.Type;

  // ─── task_status ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "task_status",
    label: "Task Status",
    description:
      "Classify the current path (PRIMARY_CHECKOUT / MANAGED_TASK_WORKTREE / etc.), report the current branch, and list all task workspaces with their branches, repos, and artifacts.",
    parameters: tb.Object({
      path: tb.Optional(
        tb.String({ description: "Path to classify (defaults to session cwd)" }),
      ),
    }),
    approval: "read",
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      try {
        const cwd = realpath(ctx.cwd);
        const targetPath = params.path ? expandPath(params.path, cwd) : cwd;
        const classification = classifyPath(targetPath, cwd);

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

        const taskWorkspaces = await scanTaskWorkspaces();

        const result = {
          classification,
          cwd: targetPath,
          repoRoot,
          branch,
          isLinkedWorktree: isLinked,
          taskRoot: TASK_ROOT,
          taskWorkspaces,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: result,
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ status: "error", message: (e as Error).message }),
            },
          ],
        };
      }
    },
  });

  // ─── ensure_task_repo ────────────────────────────────────────────────
  pi.registerTool({
    name: "ensure_task_repo",
    label: "Ensure Task Repo",
    description:
      "Attach a source repo to the task workspace as a git worktree. Reuses existing worktrees, creates new ones from local/remote branches, or fetches and creates from remote default. Never forces, resets, or detaches.",
    parameters: tb.Object({
      branch: tb.String({
        description:
          "Task branch name. Canonical call: this is the task identity. Lane call (with slot): the lane's own branch.",
      }),
      source_path: tb.String({ description: "Path to the source git repository" }),
      base_ref: tb.Optional(
        tb.String({
          description: "Explicit base ref for new branch creation (e.g. main, develop, HEAD~5)",
        }),
      ),
      remote: tb.Optional(
        tb.String({ description: "Remote name to use (defaults to auto-detect)" }),
      ),
      task: tb.Optional(
        tb.String({
          description:
            "Canonical task identity (workspace name). Required with slot for secondary lanes; ignored otherwise.",
        }),
      ),
      slot: tb.Optional(
        tb.String({
          description:
            "Secondary lane name (e.g. develop-backport). Creates a sibling <repo>__<slot> worktree inside the canonical task workspace with its own branch/base, without creating a second task workspace.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        // 1. Resolve source repo (canonicalize cwd to avoid symlink mismatches)
        const cwd = realpath(_ctx.cwd);
        const sourceAbs = expandPath(params.source_path, cwd);
        const srcRoot = await git(sourceAbs, "rev-parse", "--show-toplevel");
        if (!srcRoot.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "error",
                  message: `Not a git repository: ${params.source_path}`,
                }),
              },
            ],
          };
        }
        const sourceRoot = srcRoot.stdout;

        // 2. Workspace + target path. Canonical call: workspace identity is the
        // branch, target dir is the repo basename. Lane call: same canonical
        // workspace (identity from `task`), sibling dir <repo>__<slot>, and the
        // lane's own `branch`/base — no second task workspace, no manifest.
        if (params.slot && !params.task) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "error",
                  message:
                    "slot requires task (the canonical workspace identity) so the lane lands inside the existing task workspace",
                }),
              },
            ],
          };
        }
        if (params.slot && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(params.slot)) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "error",
                  message: "slot must match [A-Za-z0-9][A-Za-z0-9._-]*",
                }),
              },
            ],
          };
        }
        const identity = params.slot ? params.task : params.branch;
        if (identity === undefined) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "error",
                  message: "Task identity is required: pass branch, or slot together with task",
                }),
              },
            ],
          };
        }
        const ws = join(TASK_ROOT, identity.replace(/\//g, "_"));
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
                  content: [
                    {
                      type: "text" as const,
                      text: JSON.stringify({
                        status: "error",
                        message: `Target exists at ${target} but is not a worktree of ${sourceRoot}`,
                      }),
                    },
                  ],
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
              const sourceDirty = await getSourceDirty(sourceRoot);
              const headSha = await getRepoSha(target);
              const upstream = await getUpstream(sourceRoot, params.branch);
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      status: "reused",
                      worktree: target,
                      branch: params.branch,
                      branchSource: "local",
                      upstream,
                      sourceDirty,
                      headSha,
                    }),
                  },
                ],
                details: { status: "reused", worktree: target },
              };
            }
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "error",
                    message: `Worktree exists at ${target} but on branch ${currentBranch}, not ${params.branch}`,
                  }),
                },
              ],
            };
          }
        }

        // 5. Resolve remote
        let remote = params.remote;
        if (!remote) {
          const remoteList = await git(sourceRoot, "remote");
          if (!remoteList.ok) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "error",
                    message: "No remotes configured in source repo",
                  }),
                },
              ],
            };
          }
          const remotes = remoteList.stdout
            .split("\n")
            .filter((r) => r);
          if (remotes.includes("origin")) {
            remote = "origin";
          } else if (remotes.length === 1) {
            remote = remotes[0];
          } else {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "remote_selection_required",
                    remotes,
                  }),
                },
              ],
            };
          }
        }

        // 6. Branch resolution
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
                    content: [
                      {
                        type: "text" as const,
                        text: JSON.stringify({
                          status: "branch_in_use",
                          worktree: wtPath,
                        }),
                      },
                    ],
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
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      status: "branch_in_use",
                      worktree: wtPath,
                    }),
                  },
                ],
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
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "error",
                    message: `Failed to create worktree: ${add.stderr}`,
                  }),
                },
              ],
            };
          }
          const sourceDirty = await getSourceDirty(sourceRoot);
          const headSha = await getRepoSha(target);
          const upstream = await getUpstream(sourceRoot, params.branch);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "attached",
                  worktree: target,
                  branch: params.branch,
                  branchSource: "local",
                  upstream,
                  sourceDirty,
                  headSha,
                }),
              },
            ],
            details: { status: "attached", worktree: target },
          };
        }

        // 6b. Local absent — one required successful fetch of the chosen
        // remote, then resolve against the refreshed refs. Fail closed on
        // fetch failure: stale remote refs never materialize a task branch.
        const fetchRes = await git(sourceRoot, "fetch", "--prune", remote);
        if (!fetchRes.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "error",
                  message: `Fetch of ${remote} failed; refusing to create task branch from stale refs: ${fetchRes.stderr.trim()}`,
                }),
              },
            ],
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
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "error",
                    message: `Failed to create worktree from remote: ${add.stderr}`,
                  }),
                },
              ],
            };
          }
          const sourceDirty = await getSourceDirty(sourceRoot);
          const headSha = await getRepoSha(target);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "created_from_remote",
                  worktree: target,
                  branch: params.branch,
                  branchSource: "remote",
                  upstream: `${remote}/${params.branch}`,
                  remoteSha,
                  sourceDirty,
                  headSha,
                }),
              },
            ],
            details: { status: "created_from_remote", worktree: target },
          };
        }

        // 6c. Both absent — base selection
        let baseSha: string;
        let baseRef: string;

        if (params.base_ref) {
          const baseRes = await git(sourceRoot, "rev-parse", params.base_ref);
          if (!baseRes.ok) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "error",
                    message: `Invalid base ref: ${params.base_ref}`,
                  }),
                },
              ],
            };
          }
          baseSha = baseRes.stdout;
          baseRef = params.base_ref;
        } else {
          // Refs were already refreshed by the required fetch in 6b; base
          // selection must not trigger a second fetch for the same decision.
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
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "error",
                    message: `Cannot determine remote default branch for ${remote}`,
                  }),
                },
              ],
            };
          }

          // Check if develop branch exists
          const devRef = await git(
            sourceRoot,
            "show-ref",
            "--verify",
            `refs/remotes/${remote}/develop`,
          );
          const developExists = devRef.ok;

          if (remoteDefault !== "develop" && developExists) {
            // Ambiguous — ask the user
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "base_selection_required",
                    remoteDefault,
                    developExists: true,
                  }),
                },
              ],
            };
          }

          // Pick base
          const baseBranch =
            remoteDefault === "develop"
              ? `${remote}/develop`
              : `${remote}/${remoteDefault}`;
          const baseRes = await git(sourceRoot, "rev-parse", baseBranch);
          if (!baseRes.ok) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "error",
                    message: `Cannot resolve base branch ${baseBranch}`,
                  }),
                },
              ],
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
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "error",
                  message: `Failed to create worktree with branch: ${add.stderr}`,
                }),
              },
            ],
          };
        }
        const sourceDirty = await getSourceDirty(sourceRoot);
        const headSha = await getRepoSha(target);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "created",
                worktree: target,
                branch: params.branch,
                branchSource: "base",
                upstream: null,
                base: { ref: baseRef, sha: baseSha },
                sourceDirty,
                headSha,
              }),
            },
          ],
          details: { status: "created", worktree: target },
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: (e as Error).message,
              }),
            },
          ],
        };
      }
    },
  });

  // ─── checkpoint_commit ───────────────────────────────────────────────
  pi.registerTool({
    name: "checkpoint_commit",
    label: "Checkpoint Commit",
    description:
      "Stage exact paths and commit within a repository. Guards: blocks primary checkout unless allow_primary=true, rejects secret-like paths, verifies paths inside repo, enforces exact staging, requires hooks to run. deferred_hook enables controlled commit with deferred hook verification after a real external-prerequisite hook failure.",
    parameters: tb.Object({
      repo: tb.String({ description: "Repository path (root or dir inside one)" }),
      paths: tb.Array(tb.String(), {
        description: "Exact file paths to stage and commit",
      }),
      message: tb.String({ description: "Commit message" }),
      allow_primary: tb.Optional(
        tb.Boolean({
          description:
            "Allow committing to primary checkout (manual source commit exception)",
        }),
      ),
      deferred_hook: tb.Optional(
        tb.Object(
          {
            blocker_kind: tb.Union([
              tb.Literal("external_prerequisite"),
              tb.Literal("external_availability"),
            ]),
            failed_hook: tb.String(),
            failed_step_command: tb.String(),
            failure_reason: tb.String(),
            staged_tree: tb.String({
              description:
                "Staged tree SHA from the commit_failed response this evidence refers to (proves the verified contents are the contents being committed)",
            }),
            manual_checks: tb.Array(
              tb.Object({
                command: tb.String(),
                result: tb.String({
                  description:
                    "Machine-readable outcome: pass | passed | ok | success | successful | true | yes (case-insensitive). Anything else — failure, skipped, unknown, prose — does not authorize the bypass.",
                }),
              }),
            ),
            remaining_gap: tb.String(),
          },
          {
            description:
              "Deferred hook verification evidence. Only for hook failures caused by an external prerequisite or availability blocker (e.g. unpublished same-task dependency) — never for test/lint/typecheck/format/secret-scan failures. The normal hooked commit is always attempted first, in the same call. Evidence is bound to the exact staged tree reported by the failed attempt.",
          },
        ),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        // 1. Classify repo (canonicalize cwd to avoid symlink mismatches)
        const cwd = realpath(_ctx.cwd);
        const repoAbs = expandPath(params.repo, cwd);
        const classification = classifyPath(repoAbs, cwd);
        const repoRoot = realpath(findGitRoot(repoAbs) ?? repoAbs);

        if (classification === "PRIMARY_CHECKOUT" && !params.allow_primary) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "primary_commit_blocked",
                  reason: `Refusing to commit to primary checkout ${repoRoot}. Use allow_primary=true or commit to a task worktree instead.`,
                }),
              },
            ],
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
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "path_outside_repo",
                  offenders,
                }),
              },
            ],
          };
        }

        // 3. Secret check
        const secrets: string[] = [];
        for (const p of resolvedPaths) {
          if (isSecretPath(p)) secrets.push(p);
        }
        if (secrets.length > 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "secret_path_rejected",
                  offenders: secrets,
                }),
              },
            ],
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
          const different =
            existingStaged.size !== intendedSet.size ||
            [...existingStaged].some((f) => !intendedSet.has(f));
          if (different) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "ambiguous_staged",
                    staged: [...existingStaged],
                    intended: [...intendedSet],
                  }),
                },
              ],
            };
          }
        }

        // 5. Stage exactly the intended paths
        const relPaths = resolvedPaths.map((p) => relative(repoRoot, p));
        const stage = await git(repoRoot, "add", "--", ...relPaths);
        if (!stage.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "error",
                  message: `Failed to stage files: ${stage.stderr}`,
                }),
              },
            ],
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
              await git(repoRoot, "add", "--", ...relPaths);
              commit = await git(repoRoot, "commit", "-m", params.message);
            }
          }
        }
        if (!commit.ok) {
          const failureOutput = `${commit.stderr}\n${commit.stdout}`;
          if (!params.deferred_hook) {
            const finalTreeSha = (await git(repoRoot, "write-tree")).stdout.trim();
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "commit_failed",
                    stderr: commit.stderr,
                    staged_tree: finalTreeSha,
                    deferred_hook_hint:
                      "If and only if this hook failure is caused by an external prerequisite that cannot be satisfied at this task stage (e.g. an unpublished same-task dependency) — not by a code-validation failure — retry checkpoint_commit with deferred_hook evidence naming the failing step and passing this staged_tree value verbatim.",
                  }),
                },
              ],
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
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "deferred_hook_rejected",
                    evidenceTreeMatches,
                    evidenceMatches,
                    checksComplete,
                    reason:
                      "Deferred hook verification requires a current hook failure, evidence bound to the exact staged tree being committed, and manual checks with machine-readable pass results. Fix the failure or escalate instead of bypassing.",
                  }),
                },
              ],
            };
          }
          const bypass = await git(repoRoot, "commit", "--no-verify", "-m", params.message);
          if (!bypass.ok) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "error",
                    message: `Deferred hook commit failed: ${bypass.stderr}`,
                  }),
                },
              ],
            };
          }
          const deferredLog = await git(repoRoot, "log", "-1", "--format=%H");
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
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
                }),
              },
            ],
            details: {
              status: "committed_with_deferred_hook",
              commit: deferredLog.stdout,
              remaining_gap: d.remaining_gap,
            },
          };
        }

        if (!commit.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "commit_failed",
                  stderr: commit.stderr,
                }),
              },
            ],
          };
        }

        // 8. Verify
        const log = await git(repoRoot, "log", "-1", "--format=%H");
        const status = await git(repoRoot, "status", "--porcelain");
        const branch = await getRepoBranch(repoRoot);
        const remainingDirty = status.ok
          ? status.stdout
            ? status.stdout.split("\n")
            : []
          : [];

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "committed",
                commit: log.stdout,
                branch,
                files: relPaths,
                remainingDirty,
              }),
            },
          ],
          details: {
            status: "committed",
            commit: log.stdout,
            branch,
            files: relPaths,
          },
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: (e as Error).message,
              }),
            },
          ],
        };
      }
    },
  });

  // ─── Mutation guard (tool_call interceptor) ──────────────────────────
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      const input = event.input as Record<string, unknown>;
      const filePath = input.path as string | undefined;
      if (!filePath) return;
      // Internal URLs are dispatched by the core router, never resolved as
      // filesystem paths — skip classification entirely (field-run F1).
      if (INTERNAL_URI_RE.test(filePath.trim())) return;

      // Session-bound cwd (NOT process.cwd()): workspace-rooted child sessions
      // share the parent process, so relative targets must resolve against the
      // session's own directory to classify the real write target.
      const cwd = realpath(ctx.cwd);
      const classification = classifyPath(filePath, cwd);

      if (classification === "PRIMARY_CHECKOUT") {
        const root = findGitRoot(expandPath(filePath, cwd));
        const hint = root ? managedWorktreeHint(root) : null;
        if (root && hint) {
          return {
            block: true,
            reason: `Blocked: writing to primary checkout ${root}. Use the managed task worktree(s) of this repo: ${hint}. This block is a routing failure, not a bypass authorization — do not work around it with eval, Python, shell, or another agent; write to the managed worktree or report the blocker.`,
          };
        }
      }
      return;
    }

    if (event.toolName !== "bash") return;
    const input = event.input as Record<string, unknown>;
    const command = input.command as string | undefined;
    if (!command) return;

    const invocations = parseGitInvocations(command);

    // Raw hook bypass is policy, not routing: forbidden everywhere, including
    // managed worktrees. The controlled deferral path lives in
    // checkpoint_commit, which requires a real, current hook failure first.
    if (invocations.some((inv) => inv.mutating && inv.noVerify)) {
      return {
        block: true,
        reason:
          "Blocked: raw `git commit --no-verify` bypasses pre-commit hooks. Commit normally (hooks run); if a hook fails on an external prerequisite such as an unpublished same-task dependency, retry via checkpoint_commit with deferred_hook evidence.",
      };
    }

    // Compound commands must not hide a mutating git invocation behind
    // read-only ones: EVERY git invocation in the command is classified, and
    // any mutating one aimed at a primary checkout with managed worktrees
    // blocks the whole command (fail closed on ambiguity).
    const cwd = realpath(ctx.cwd);
    for (const inv of invocations) {
      if (!inv.mutating) continue;
      const repoRef = inv.repoRef ?? ".";
      // A URI-like repo ref (git -C local://… …) is never a filesystem repo.
      if (INTERNAL_URI_RE.test(repoRef.trim())) continue;
      const repoAbs = expandPath(repoRef, cwd);
      let classification: PathClassification;
      try {
        classification = classifyPath(repoAbs, cwd);
      } catch {
        continue; // unresolvable -C target can never be the primary checkout
      }
      if (classification !== "PRIMARY_CHECKOUT") continue;
      const root = findGitRoot(repoAbs);
      if (!root) continue;
      const hint = managedWorktreeHint(root);
      if (!hint) continue;
      return {
        block: true,
        reason: `Blocked: mutating git command on primary checkout ${root}. Use the managed task worktree(s) of this repo: ${hint}. This block is a routing failure, not a bypass authorization — do not work around it with eval, Python, shell, or another agent; run the command in the managed worktree or report the blocker.`,
      };
    }
  });
}
