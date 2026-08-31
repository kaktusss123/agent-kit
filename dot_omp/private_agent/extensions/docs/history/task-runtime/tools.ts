/**
 * Model-callable tools (V2 task runtime).
 *
 * Each tool's `execute` closes over `pi.exec` (captured at registration
 * time) and dispatches into the shared `lifecycle.ts` functions. Tools
 * never bypass the state machine.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { snapshotHandoffPath } from "./paths.ts";
import type { ExecFn } from "./types.ts";
import type {
  RepoRole,
  TaskType,
  VerificationCheck,
} from "./types.ts";
import { LifecycleError } from "./lifecycle.ts";
import {
  attachRepoToTask,
  blockTask,
  buildHandoff,
  createTask,
  markReady,
  recordDecision,
  resumeFromBlock,
  setVerification,
  startImplementation,
  submitImplementation,
  taskStatus,
  writeArtifact,
  approveTask,
  prepareWorktrees,
} from "./lifecycle.ts";
import { loadManifest } from "./storage.ts";
import { roleForSession } from "./permissions.ts";
import { LegacyTaskError, TaskNotFoundError } from "./storage.ts";
import { LifecycleError as LifecycleErr } from "./lifecycle.ts";
import { getTaskRoot, isValidTaskId } from "./paths.ts";

/**
 * Build an `ExecFn` from the OMP extension API's `pi.exec`.
 */
export function execFnFromPi(pi: ExtensionAPI): ExecFn {
  return async (cmd, args, options) => {
    const r = await pi.exec(cmd, args, options);
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
  };
}

/**
 * Look up the current session file from the ExtensionContext. The runtime
 * binds sessions to roles via this file path; we never infer role from cwd.
 */
function currentSessionFile(ctx: ExtensionContext): string | undefined {
  return ctx.sessionManager.getSessionFile();
}

/**
 * Enforce that the calling session is bound to a specific role for the
 * task. Returns null when the session is not bound (the tool then returns
 * an explicit error to the LLM).
 */
async function requireRole(
  ctx: ExtensionContext,
  taskId: string,
  role: "cracker" | "implementer",
): Promise<{ ok: true; sessionFile: string } | { ok: false; reason: string }> {
  const sessionFile = currentSessionFile(ctx);
  if (!sessionFile) return { ok: false, reason: "no current session file" };
  // We need the manifest to verify the binding; load it best-effort.
  let manifest;
  try {
    manifest = await loadManifest(taskId);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const bound = roleForSession(manifest, sessionFile);
  if (bound !== role) {
    return {
      ok: false,
      reason: `session is not bound as role "${role}" for task "${taskId}" (current binding: ${bound ?? "none"})`,
    };
  }
  return { ok: true, sessionFile };
}


/**
 * Helper that wraps a tool call result into the standard success shape.
 */
function ok(details: Record<string, unknown>, text?: string) {
  return {
    content: [{ type: "text" as const, text: text ?? JSON.stringify(details, null, 2) }],
    details,
  };
}

function err(reason: string) {
  return {
    content: [{ type: "text" as const, text: `error: ${reason}` }],
    details: { error: reason },
    isError: true,
  };
}

/**
 * Register all V2 task-runtime tools on the given ExtensionAPI.
 *
 * The schema for tool parameters uses `pi.zod`, which is the in-tree Zod-
 * compatible schema builder exposed by OMP.
 */
export function registerTaskRuntimeTools(pi: ExtensionAPI): void {
  const z = pi.zod;
  const exec = execFnFromPi(pi);

  // ─── task_status ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "task_status",
    label: "Task Status",
    description:
      "Return the current structured status of a V2 task (phase, repos, open decisions, approval, sessions, blocker).",
    parameters: z.object({ taskId: z.string().describe("task id") }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      try {
        const s = await taskStatus(params.taskId);
        return ok({ status: s });
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });

  // ─── task_attach_repo ─────────────────────────────────────────────────
  pi.registerTool({
    name: "task_attach_repo",
    label: "Attach Repo",
    description:
      "Attach a target or reference repo to a V2 task. Same implementation as /task_add_repo.",
    parameters: z.object({
      taskId: z.string().describe("task id"),
      path: z.string().describe("absolute path or path under $HOME (uses ~)"),
      role: z.enum(["target", "reference"]).describe("repo role"),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      try {
        if (!isValidTaskId(params.taskId)) return err(`invalid task id`);
        const sessionFile = currentSessionFile(ctx);
        if (!sessionFile) return err("no current session file");
        const manifest = await loadManifest(params.taskId);
        const bound = roleForSession(manifest, sessionFile);
        if (bound !== "cracker") {
          return err(`attach requires cracker role; current binding is ${bound ?? "none"}`);
        }
        const m = await attachRepoToTask({
          exec,
          taskId: params.taskId,
          rawPath: params.path,
          role: params.role as Exclude<RepoRole, "primary">,
        });
        return ok({ taskId: params.taskId, manifest: m });
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });

  // ─── task_write_artifact ─────────────────────────────────────────────
  pi.registerTool({
    name: "task_write_artifact",
    label: "Write Task Artifact",
    description:
      "Write spec.md or evidence.md for a V2 task. Cracker session only; rewrites after ready_for_approval revert phase to discovery.",
    parameters: z.object({
      taskId: z.string().describe("task id"),
      kind: z.enum(["spec", "evidence"]).describe("which artifact"),
      content: z.string().describe("file content"),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      try {
        const auth = await requireRole(ctx, params.taskId, "cracker");
        if (!auth.ok) return err(auth.reason);
        const m = await writeArtifact({
          taskId: params.taskId,
          kind: params.kind,
          content: params.content,
        });
        return ok({ taskId: params.taskId, manifest: m });
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });

  // ─── task_record_decision ────────────────────────────────────────────
  pi.registerTool({
    name: "task_record_decision",
    label: "Record Decision",
    description:
      "Open or resolve a structured decision. Cracker session only.",
    parameters: z.object({
      taskId: z.string(),
      action: z.enum(["open", "resolve"]),
      decisionId: z.string(),
      question: z.string().optional(),
      dependsOn: z.array(z.string()).optional(),
      options: z.array(z.string()).optional(),
      recommendation: z.string().optional(),
      reason: z.string().optional(),
      answer: z.string().optional(),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      try {
        const auth = await requireRole(ctx, params.taskId, "cracker");
        if (!auth.ok) return err(auth.reason);
        const m = await recordDecision({
          taskId: params.taskId,
          action: params.action,
          decisionId: params.decisionId,
          ...(params.question ? { question: params.question } : {}),
          ...(params.dependsOn ? { dependsOn: params.dependsOn } : {}),
          ...(params.options ? { options: params.options } : {}),
          ...(params.recommendation ? { recommendation: params.recommendation } : {}),
          ...(params.reason ? { reason: params.reason } : {}),
          ...(params.answer ? { answer: params.answer } : {}),
        });
        return ok({ taskId: params.taskId, manifest: m });
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });

  // ─── task_set_verification ───────────────────────────────────────────
  pi.registerTool({
    name: "task_set_verification",
    label: "Set Verification Contract",
    description:
      "Define the deterministic verification contract for the task. Cracker session only.",
    parameters: z.object({
      taskId: z.string(),
      checks: z.array(z.object({
        id: z.string(),
        repo: z.string(),
        command: z.string(),
        required: z.boolean(),
      })),
      manualReason: z.string().optional(),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      try {
        const auth = await requireRole(ctx, params.taskId, "cracker");
        if (!auth.ok) return err(auth.reason);
        const m = await setVerification({
          taskId: params.taskId,
          checks: params.checks as VerificationCheck[],
          ...(params.manualReason ? { manualReason: params.manualReason } : {}),
        });
        return ok({ taskId: params.taskId, manifest: m });
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });

  // ─── task_mark_ready ─────────────────────────────────────────────────
  pi.registerTool({
    name: "task_mark_ready",
    label: "Mark Ready For Approval",
    description:
      "Run readiness validation and (if passing) transition the task to ready_for_approval. Cracker session only.",
    parameters: z.object({ taskId: z.string() }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      try {
        const auth = await requireRole(ctx, params.taskId, "cracker");
        if (!auth.ok) return err(auth.reason);
    const exec = execFnFromPi(pi);
    const r = await markReady(params.taskId, exec);
        return ok({ taskId: params.taskId, ...r });
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });

  // ─── task_block ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "task_block",
    label: "Block On Spec Conflict",
    description:
      "Implementer signals a semantic conflict with the approved contract; transitions implementing → blocked.",
    parameters: z.object({
      taskId: z.string(),
      reason: z.string().describe("SPEC_CONFLICT explanation including Observed / Approved contract / Options / Recommendation"),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      try {
        const auth = await requireRole(ctx, params.taskId, "implementer");
        if (!auth.ok) return err(auth.reason);
        const m = await blockTask({ taskId: params.taskId, reason: params.reason });
        return ok({ taskId: params.taskId, manifest: m });
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });

  // ─── task_submit ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "task_submit",
    label: "Submit For Completion",
    description:
      "Run deterministic verification + write policy. Implementer session only. Returns failure details to the same session on failure.",
    parameters: z.object({ taskId: z.string() }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      try {
        const auth = await requireRole(ctx, params.taskId, "implementer");
        if (!auth.ok) return err(auth.reason);
        const out = await submitImplementation({ taskId: params.taskId, exec });
        // Block result: the implementer session must see failure inline
        if (out.kind === "still_implementing") {
          return {
            content: [{
              type: "text" as const,
              text: `FAILED: ${out.reason}\n\nFix the issue in the same session and call task_submit again.\n\n${
                out.verification
                  ? "verification:\n" +
                    out.verification.outcomes.map(o => `  [${o.status}] ${o.id}: exit=${o.exitCode}\n    stdout: ${o.stdoutTail}\n    stderr: ${o.stderrTail}`).join("\n")
                  : ""
              }\n${
                out.diffSummary
                  ? "diffs:\n" + out.diffSummary.map(d => `  ${d.repo}: ${d.changedFileCount} files (+${d.insertions}/-${d.deletions}) empty=${d.isEmpty}`).join("\n")
                  : ""
              }`,
            }],
            details: { kind: out.kind, reason: out.reason, ...out },
            isError: true,
          };
        }
        if (out.kind === "blocked_manual") {
          return {
            content: [{
              type: "text" as const,
              text: `BLOCKED_MANUAL_VERIFICATION: ${out.reason}`,
            }],
            details: { kind: out.kind, ...out },
            isError: true,
          };
        }
        if (out.kind === "error") {
          return err(out.reason);
        }
        // completed
        return ok({
          kind: "completed",
          verification: out.verification,
          diffSummary: out.diffSummary,
        }, `task completed`);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });
}

/**
 * Re-exported helper for the slash command side that wants to create a task
 * with the cracker session captured.
 */
export async function createTaskForInit(input: {
  pi: ExtensionAPI;
  taskId: string;
  type: TaskType;
  primarySourcePath: string;
  description?: string;
  crackerSessionFile: string | undefined;
}): Promise<{ id: string; primaryRepo: string; worktreePath?: string }> {
  const exec = execFnFromPi(input.pi);
  const manifest = await createTask({
    id: input.taskId,
    type: input.type,
    ...(input.description ? { description: input.description } : {}),
    primarySourcePath: input.primarySourcePath,
    crackerSessionFile: input.crackerSessionFile,
    exec,
  });
  return {
    id: manifest.id,
    primaryRepo: manifest.primaryRepo,
    worktreePath: manifest.repos[manifest.primaryRepo]?.worktreePath,
  };
}

/**
 * Used by the slash command side for approve + handoff.
 */
export async function approveAndPrepareHandoff(input: {
  pi: ExtensionAPI;
  taskId: string;
}): Promise<{
  approvalId: string;
}> {
  const exec = execFnFromPi(input.pi);
  const { approval } = await approveTask({ taskId: input.taskId, exec });
  return {
    approvalId: approval.id,
  };
}

/**
 * Start the implementation: transition to `implementing`, bind the new
 * implementer session file. Caller must already have called
 * `ctx.newSession(...)` and possess the new session file.
 */
export async function startImplementationForHandoff(input: {
  taskId: string;
  approvalId: string;
  implementerSessionFile: string;
  pi: ExtensionAPI;
}): Promise<void> {
  const exec = execFnFromPi(input.pi);
  await startImplementation({
    taskId: input.taskId,
    approvalId: input.approvalId,
    implementerSessionFile: input.implementerSessionFile,
    exec,
  });
}

export async function resumeBlockForTask(taskId: string): Promise<void> {
  await resumeFromBlock(taskId);
}
