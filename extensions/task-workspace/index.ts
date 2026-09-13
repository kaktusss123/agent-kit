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
 * This file owns everything host-specific: ExtensionAPI tool registration,
 * TypeBox schemas, session-cwd translation, and the tool-result
 * representation (content JSON plus the structured `details` attachment).
 * The task root itself is not host-owned: it is resolved once per
 * registration by the task-root resolver in ./task-root.
 * The deterministic mechanics live in the sibling modules (flows.ts,
 * git.ts, guard.ts, types.ts) — a host-independent core that receives its
 * task root explicitly and returns plain domain results.
 *
 * This directory is loaded as an additional extension entry by other
 * consumers (e.g. child agent profiles); it must stay self-contained under
 * extensions/task-workspace/ — no imports from sibling extension directories.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type as tb } from "typebox";
import { resolveTaskRoot } from "./task-root";
import {
  checkpointCommit,
  ensureTaskRepo,
  removeTaskLane,
  taskStatus,
} from "./flows";
import {
  guardManagedBashCommand,
  guardManagedWriteTarget,
} from "./guard";

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
  });

  // ─── ensure_task_repo ────────────────────────────────────────────────
  pi.registerTool({
    name: "ensure_task_repo",
    label: "Ensure Task Repo",
    description:
      "Attach a source repo to the task workspace as a git worktree. Results identify the task, canonical-or-lane kind, slot, target worktree, branch/base provenance, upstream, and the exact inputRepo checkout facts. Reuses existing worktrees, creates new ones from local/remote branches, or fetches and creates from remote default. Never forces, resets, or detaches.",
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
        const result = await ensureTaskRepo(params, _ctx.cwd, { taskRoot: TASK_ROOT });
        return respond(result, detailsFor("ensure_task_repo", result));
      } catch (e) {
        return respond(errorResult(e));
      }
    },
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
        const result = await checkpointCommit(params, _ctx.cwd, { taskRoot: TASK_ROOT });
        return respond(result, detailsFor("checkpoint_commit", result));
      } catch (e) {
        return respond(errorResult(e));
      }
    },
  });

  // ─── Mutation guard (tool_call interceptor) ──────────────────────────
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      const input = event.input as Record<string, unknown>;
      return guardManagedWriteTarget(input.path as string | undefined, ctx.cwd, {
        taskRoot: TASK_ROOT,
      });
    }

    if (event.toolName !== "bash") return;
    const input = event.input as Record<string, unknown>;
    return guardManagedBashCommand(input.command as string | undefined, ctx.cwd, {
      taskRoot: TASK_ROOT,
    });
  });
}
