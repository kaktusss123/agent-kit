/**
 * task-workspace — pi binding for the deterministic task-workspace runtime.
 *
 * Manages git worktrees for multi-repo task isolation.
 * Branch = task identity. Workspace root = the task root resolved by
 * ./task-root (AGENT_TASK_ROOT override, then the ~/.agent-kit/tasks
 * default) + /<branch_flat>/.
 * All state lives in git (branches + worktrees); no manifest files.
 *
 * Residual limitation (accepted by design): flattening a branch name into the
 * workspace directory name is not injective — distinct branch identities can
 * produce the same directory. No manifest or naming migration exists; resolve
 * a real collision manually if one ever materializes.
 *
 * Git mutation policy is enforced where git actually executes: the
 * built-in bash tool is overridden with createBashTool + a spawnHook that
 * prepends the PATH shim (./shim/git) to every bash child and points it
 * at the policy module (./shim/policy.mjs). Every real git invocation
 * then reports its post-`cd` cwd and exact argv to the policy. Mutations in
 * managed or other linked worktrees pass; primary-checkout mutations block
 * when managed worktrees exist. There is deliberately NO Bash parsing
 * anywhere in agent-kit; write/edit calls keep their
 * tool_call interception (guard.ts).
 *
 * This file owns everything host-specific: ExtensionAPI tool registration,
 * TypeBox schemas, session-cwd translation, and the tool-result
 * representation (content JSON plus the structured `details` attachment).
 * The task root itself is not host-owned: it is resolved once per
 * registration by the task-root resolver in ./task-root.
 * The deterministic mechanics live in the sibling modules (flows.ts,
 * git.ts, guard.ts, shim-path.ts, types.ts) — a host-independent core that
 * receives its task root explicitly and returns plain domain results.
 *
 * This directory is loaded as an additional extension entry by other
 * consumers (e.g. child agent profiles); it must stay self-contained under
 * extensions/task-workspace/ — no imports from sibling extension directories.
 */
import type {
  BashSpawnContext,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type as tb } from "typebox";
import { resolveTaskRoot } from "./task-root";
import {
  SESSION_SELECTION_ENTRY_TYPE,
  isRecordableEnsureStatus,
} from "./current";
import {
  checkpointCommit,
  ensureTaskRepo,
  removeTaskLane,
  taskStatus,
  teardownTaskRepo,
} from "./flows";
import { BOOTSTRAP_CONFIG } from "./bootstrap-config";
export { BOOTSTRAP_CONFIG } from "./bootstrap-config";
import { guardManagedWriteTarget } from "./guard";
import {
  renderCheckpointCommitCall,
  renderCheckpointCommitResult,
  renderEnsureTaskRepoCall,
  renderEnsureTaskRepoResult,
  renderRemoveTaskLaneCall,
  renderRemoveTaskLaneResult,
  renderTaskStatusCall,
  renderTaskStatusResult,
  renderTeardownTaskRepoCall,
  renderTeardownTaskRepoResult,
  type RenderOptions,
  type TaskStatusResultLike,
  type ToolResultLike,
} from "./render";
import { resolveGitOnPath } from "./shim-path";
export { resolveGitOnPath } from "./shim-path";

function respond(result: Record<string, unknown>, details?: unknown): {
  content: { type: "text"; text: string }[];
  details: unknown;
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    // vanilla pi requires the details key on AgentToolResult
    details,
  };
}

function errorResult(e: unknown): Record<string, unknown> {
  return { status: "error", message: (e as Error).message };
}

/** Session-current persistence (the ZAVOD-5 selection contract): one custom
 *  session-history entry per SUCCESSFUL ensure_task_repo, recorded through
 *  pi.appendEntry. The inspection channel reconstructs the session-scoped
 *  current-task projection from these entries via the session manager's
 *  current branch — no manifest files, no writable inspection API. Failed
 *  calls never append, so they never replace the current task. Best-effort:
 *  a persistence failure must not fail an already-successful ensure; the
 *  projection then truthfully reports no session association. */
function recordSessionSelection(
  pi: ExtensionAPI,
  result: Record<string, unknown>,
): void {
  if (!isRecordableEnsureStatus(result.status)) return;
  try {
    pi.appendEntry(SESSION_SELECTION_ENTRY_TYPE, {
      task: result.task,
      worktree: result.worktree,
    });
  } catch {
    // Selection stays absent — "none" is the truthful projection.
  }
}

// ─── Bash git guard: PATH shim wiring ────────────────────────────────

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const SHIM_DIR = join(EXTENSION_DIR, "shim");
const POLICY_PATH = join(SHIM_DIR, "policy.mjs");

/** Build the spawnHook for the overridden bash tool: arm the PATH shim for
 *  each child. Real git is resolved from the ORIGINAL PATH before
 *  prepending; if git or anything else cannot be resolved, the context is
 *  returned unchanged (fail open — bash behaves stock). The returned env
 *  is a NEW object built by pi from getShellEnv(); process.env of the pi
 *  process is never mutated, so every extension-side child_process call
 *  (git.ts, flows.ts) stays on the unmodified environment and never sees
 *  the shim. */
export function armGitShim(taskRoot: string) {
  return ({ command, cwd, env }: BashSpawnContext): BashSpawnContext => {
    try {
      const realGit = env.PATH
        ? resolveGitOnPath(env.PATH, cwd, SHIM_DIR)
        : null;
      if (!realGit) return { command, cwd, env };
      return {
        command,
        cwd,
        env: {
          ...env,
          PATH: `${SHIM_DIR}:${env.PATH ?? ""}`,
          AGENT_TASK_ROOT: taskRoot,
          AGENT_KIT_REAL_GIT: realGit,
          AGENT_KIT_POLICY_RUNTIME: process.execPath,
          AGENT_KIT_POLICY: POLICY_PATH,
        },
      };
    } catch {
      return { command, cwd, env };
    }
  };
}

/**
 * Structured `details` attachment per tool and outcome. Preserves the exact
 * pre-split behavior: only these status values carry details, and only
 * these fields.
 */
function detailsFor(tool: string, result: Record<string, unknown>): unknown {
  switch (tool) {
    case "task_status":
      return result;
    case "ensure_task_repo":
      if (
        result.status === "reused" ||
        result.status === "attached" ||
        result.status === "created_from_remote" ||
        result.status === "created"
      ) {
        return { status: result.status, worktree: result.worktree };
      }
      return undefined;
    case "remove_task_lane":
      return result.status === "removed" ? { ...result } : undefined;
    case "teardown_task_repo":
      return result.status === "torn_down" ? { ...result } : undefined;
    case "checkpoint_commit":
      if (result.status === "committed") {
        return {
          status: result.status,
          commit: result.commit,
          branch: result.branch,
          files: result.files,
        };
      }
      if (result.status === "committed_with_deferred_hook") {
        return {
          status: result.status,
          commit: result.commit,
          remaining_gap: result.remaining_gap,
        };
      }
      return undefined;
    default:
      return undefined;
  }
}

export default function (pi: ExtensionAPI): void {
  // Task-root policy, owned by the task subsystem (see ./task-root):
  // AGENT_TASK_ROOT override, then the ~/.agent-kit/tasks default. Resolved
  // once per registration (production registers at startup, so the effective
  // behavior equals module-load resolution); the core receives it explicitly
  // and never reads the environment itself.
  const TASK_ROOT = resolveTaskRoot();

  // ─── bash tool override (git PATH shim) ──────────────────────────────
  // Same contract and schema as the built-in bash tool (spread + execute
  // delegation); the spawnHook prepends the git PATH shim to each child.
  // When the session has no cwd the tool's construction cwd applies.
  const bashTool = createBashTool(process.cwd(), {
    spawnHook: armGitShim(TASK_ROOT),
  });
  pi.registerTool({
    ...bashTool,
    execute: (toolCallId, params, signal, onUpdate) =>
      bashTool.execute(toolCallId, params, signal, onUpdate),
  });

  // typebox is imported directly (vanilla pi has no pi.typebox injection)
  // ─── task_status ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "task_status",
    label: "Task Status",
    description:
      "Classify the current path and report current Git facts; list each managed task workspace with canonical-or-lane kind, slot, path, branch, HEAD, upstream, classification, dirty paths, and artifacts.",
    parameters: tb.Object({
      path: tb.Optional(
        tb.String({ description: "Path to classify (defaults to session cwd)" }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      try {
        const result = await taskStatus(params, ctx.cwd, { taskRoot: TASK_ROOT });
        return respond(result, detailsFor("task_status", result));
      } catch (e) {
        return respond(errorResult(e));
      }
    },
    renderCall: (args, theme) => renderTaskStatusCall(args as { path?: string }, theme),
    renderResult: (result, options, theme) =>
      renderTaskStatusResult(result as TaskStatusResultLike, options as RenderOptions, theme),
  });

  // ─── ensure_task_repo ────────────────────────────────────────────────
  pi.registerTool({
    name: "ensure_task_repo",
    label: "Ensure Task Repo",
    description:
      "Attach a source repo to the task workspace as a git worktree. Results identify the task, canonical-or-lane kind, slot, target worktree, branch/base provenance, upstream, and the exact inputRepo checkout facts. Reuses existing worktrees, creates new ones from local/remote branches, or fetches and creates from remote default. Protected default development branches (main, master, develop) are refused as task branches. Never forces, resets, or detaches.",
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
        const result = await ensureTaskRepo(params, _ctx.cwd, {
          taskRoot: TASK_ROOT,
          bootstrap: { config: BOOTSTRAP_CONFIG, env: process.env },
        });
        recordSessionSelection(pi, result);
        return respond(result, detailsFor("ensure_task_repo", result));
      } catch (e) {
        return respond(errorResult(e));
      }
    },
    renderCall: (args, theme) => renderEnsureTaskRepoCall(args as { branch?: string; slot?: string }, theme),
    renderResult: (result, options, theme) =>
      renderEnsureTaskRepoResult(result as ToolResultLike, options as RenderOptions, theme),
  });

  // ─── remove_task_lane ────────────────────────────────────────────────
  pi.registerTool({
    name: "remove_task_lane",
    label: "Remove Task Lane",
    description:
      "Safely remove one clean secondary lane from its managed task workspace. Canonical worktrees are rejected; worktree removal and branch deletion are both non-force operations.",
    parameters: tb.Object({
      task: tb.String({
        description: "Canonical task identity (workspace name)",
      }),
      path: tb.String({
        description: "Absolute or session-relative path to the secondary lane",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await removeTaskLane(params, _ctx.cwd, { taskRoot: TASK_ROOT });
        return respond(result, detailsFor("remove_task_lane", result));
      } catch (e) {
        return respond(errorResult(e));
      }
    },
    renderCall: (args, theme) => renderRemoveTaskLaneCall(args as { task?: string; path?: string }, theme),
    renderResult: (result, options, theme) =>
      renderRemoveTaskLaneResult(result as ToolResultLike, options as RenderOptions, theme),
  });

  // ─── teardown_task_repo ──────────────────────────────────────────
  pi.registerTool({
    name: "teardown_task_repo",
    label: "Teardown Task Repo",
    description:
      "Guarded teardown of one whole canonical task workspace: refuse when any worktree has uncommitted changes, when a task branch is checked out outside the workspace (e.g. by another session), or when a task branch has commits not contained in its upstream or base HEAD (non-force). On success: remove all repo worktrees registered under the task workspace, delete the task branches (non-force), and clean the task root metadata directory. Multi-repo workspaces are fully handled.",
    parameters: tb.Object({
      task: tb.String({
        description: "Canonical task identity (workspace name, as task_status reports it)",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await teardownTaskRepo(params, _ctx.cwd, { taskRoot: TASK_ROOT });
        return respond(result, detailsFor("teardown_task_repo", result));
      } catch (e) {
        return respond(errorResult(e));
      }
    },
    renderCall: (args, theme) => renderTeardownTaskRepoCall(args as { task?: string }, theme),
    renderResult: (result, options, theme) =>
      renderTeardownTaskRepoResult(result as ToolResultLike, options as RenderOptions, theme),
  });

  // ─── checkpoint_commit ───────────────────────────────────────────────
  pi.registerTool({
    name: "checkpoint_commit",
    label: "Checkpoint Commit",
    description:
      "Stage exact paths and commit within a repository. Guards: blocks primary checkout unless allow_primary=true, rejects secret-like paths, verifies paths inside repo, enforces exact staging, requires hooks to run, and verifies the created commit against paths (a hook-staged extra file fails closed as commit_scope_mismatch). deferred_hook enables controlled commit with deferred hook verification after a real external-prerequisite hook failure.",
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
        const result = await checkpointCommit(params, _ctx.cwd, { taskRoot: TASK_ROOT });
        return respond(result, detailsFor("checkpoint_commit", result));
      } catch (e) {
        return respond(errorResult(e));
      }
    },
    renderCall: (args, theme) => renderCheckpointCommitCall(args as { repo?: string; message?: string }, theme),
    renderResult: (result, options, theme) =>
      renderCheckpointCommitResult(result as ToolResultLike, options as RenderOptions, theme),
  });

  // ─── Mutation guard (tool_call interceptor) ──────────────────────────
  // Write/edit targets only: bash git mutations are enforced where git
  // executes, via the PATH shim armed above — no shell parsing here (or
  // anywhere else in agent-kit).
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      const input = event.input as Record<string, unknown>;
      return guardManagedWriteTarget(input.path as string | undefined, ctx.cwd, {
        taskRoot: TASK_ROOT,
      });
    }
    return;
  });
}
