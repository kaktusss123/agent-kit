/**
 * task-workspace — OMP binding for the deterministic task-workspace runtime.
 *
 * Manages git worktrees for multi-repo task isolation.
 * Branch = task identity. Workspace root = ~/.omp/tasks/<branch_flat>/.
 * All state lives in git (branches + worktrees); no manifest files.
 *
 * Residual limitation (accepted by design): flattening a branch name into the
 * workspace directory name is not injective — distinct branch identities can
 * produce the same directory. No manifest or naming migration exists; resolve
 * a real collision manually if one ever materializes.
 *
 * The deterministic mechanics (task identity, worktree/lane lifecycle, git
 * mutation classification, commit safety) live in ./task-workspace/ — a
 * host-independent core with no OMP/Pi SDK imports. This file is only the
 * binding: ExtensionAPI tool registration, TypeBox schemas, session-cwd
 * translation, and result serialization.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  checkpointCommit,
  ensureTaskRepo,
  removeTaskLane,
  taskStatus,
} from "./task-workspace/flows";
import {
  guardManagedBashCommand,
  guardManagedWriteTarget,
} from "./task-workspace/guard";
import type { FlowOutcome } from "./task-workspace/types";

function respond(outcome: FlowOutcome): {
  content: { type: "text"; text: string }[];
  details?: unknown;
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(outcome.payload) }],
    ...(outcome.details !== undefined ? { details: outcome.details } : {}),
  };
}

export default function (pi: ExtensionAPI): void {
  const tb = pi.typebox.Type;

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
    approval: "read",
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      try {
        return respond(await taskStatus(params, ctx.cwd));
      } catch (e) {
        return respond({ payload: { status: "error", message: (e as Error).message } });
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
        return respond(await ensureTaskRepo(params, _ctx.cwd));
      } catch (e) {
        return respond({ payload: { status: "error", message: (e as Error).message } });
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
    approval: "write",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        return respond(await removeTaskLane(params, _ctx.cwd));
      } catch (e) {
        return respond({ payload: { status: "error", message: (e as Error).message } });
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
        return respond(await checkpointCommit(params, _ctx.cwd));
      } catch (e) {
        return respond({ payload: { status: "error", message: (e as Error).message } });
      }
    },
  });

  // ─── Mutation guard (tool_call interceptor) ──────────────────────────
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      const input = event.input as Record<string, unknown>;
      return guardManagedWriteTarget(input.path as string | undefined, ctx.cwd);
    }

    if (event.toolName !== "bash") return;
    const input = event.input as Record<string, unknown>;
    return guardManagedBashCommand(input.command as string | undefined, ctx.cwd);
  });
}
