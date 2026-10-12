/**
 * task-workspace — CLI binding for hosts without pi extensions (Claude Code).
 *
 * Second consumer of the host-independent core: the same flows the pi
 * binding (index.ts) registers as tools, exposed as `agent-kit task <op>`
 * with JSON in and JSON out. Parameters are the pi tool parameters verbatim
 * (snake_case keys), so the operating contracts in skills/git-task and
 * skills/git-commit describe both bindings.
 *
 *   agent-kit task status        ['{"path": …}']
 *   agent-kit task ensure        '{"branch": …, "source_path": …, …}'
 *   agent-kit task remove-lane   '{"task": …, "path": …}'
 *   agent-kit task teardown      '{"task": …}'
 *   agent-kit task commit        '{"repo": …, "paths": […], "message": …, …}'
 *   agent-kit task hook session-start | pre-tool-use   (Claude Code hooks)
 *
 * The params argument may be `-` (read JSON from stdin). The session cwd is
 * the process cwd. Exit codes: 0 — the flow returned a result with a
 * meaningful status (including refusals such as base_selection_required);
 * 1 — tool error (`status: "error"`); 2 — usage error. Output is always one
 * JSON object on stdout.
 *
 * Hooks fail open: any internal error or missing input leaves the tool call
 * and the session environment untouched (the guard is routing protection,
 * not a sandbox).
 */
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BOOTSTRAP_CONFIG } from "./bootstrap-config";
import {
  checkpointCommit,
  ensureTaskRepo,
  removeTaskLane,
  taskStatus,
  teardownTaskRepo,
} from "./flows";
import { guardManagedWriteTarget } from "./guard";
import { isShimScript, resolveGitOnPath } from "./shim-path";
import { resolveTaskRoot } from "./task-root";

const SHIM_DIR = join(dirname(fileURLToPath(import.meta.url)), "shim");
const POLICY_PATH = join(SHIM_DIR, "policy.mjs");

type Params = Record<string, unknown>;
type Flow = (params: Params, cwd: string, taskRoot: string) => Promise<Record<string, unknown>>;

const FLOWS: Record<string, Flow> = {
  status: (p, cwd, taskRoot) => taskStatus(p as { path?: string }, cwd, { taskRoot }),
  ensure: (p, cwd, taskRoot) =>
    ensureTaskRepo(p as unknown as Parameters<typeof ensureTaskRepo>[0], cwd, {
      taskRoot,
      bootstrap: { config: BOOTSTRAP_CONFIG, env: process.env },
    }),
  "remove-lane": (p, cwd, taskRoot) =>
    removeTaskLane(p as unknown as Parameters<typeof removeTaskLane>[0], cwd, { taskRoot }),
  teardown: (p, cwd, taskRoot) =>
    teardownTaskRepo(p as unknown as Parameters<typeof teardownTaskRepo>[0], cwd, { taskRoot }),
  commit: (p, cwd, taskRoot) =>
    checkpointCommit(p as unknown as Parameters<typeof checkpointCommit>[0], cwd, { taskRoot }),
};

/** Required string parameters per op: checked before the flow runs, so a
 *  malformed call is a usage error instead of a half-run flow. */
const REQUIRED: Record<string, string[]> = {
  status: [],
  ensure: ["branch", "source_path"],
  "remove-lane": ["task", "path"],
  teardown: ["task"],
  commit: ["repo", "message"],
};

/** The CLI's own git must be real git: in a guarded Claude Code session the
 *  inherited PATH starts with the shim, and the flows (worktree add on the
 *  source repo, checkpoint commits) would otherwise be routed through the
 *  policy meant for the agent's Bash commands. Same isolation the pi
 *  binding gets by never mutating its own process.env. */
export function stripShimFromPath(pathValue: string): string {
  return pathValue
    .split(":")
    .filter((entry) => !entry || !isShimScript(join(entry, "git")))
    .join(":");
}

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function usage(message: string): number {
  out({
    status: "usage_error",
    message,
    usage: "agent-kit task <status|ensure|remove-lane|teardown|commit> ['<json params>' | -]",
  });
  return 2;
}

/** Single-quote a value for a POSIX shell `export` line. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** SessionStart: arm the git PATH shim for every Bash command of the
 *  session (and its subagents) through CLAUDE_ENV_FILE — the same four
 *  variables the pi binding's spawnHook sets. No env file or no real git →
 *  nothing is written (fail open: Bash stays stock). */
export function sessionStartExports(env: Record<string, string | undefined>, cwd: string): string | null {
  const realGit = env.PATH ? resolveGitOnPath(env.PATH, cwd, SHIM_DIR) : null;
  if (!realGit) return null;
  return [
    `export AGENT_TASK_ROOT=${shq(resolveTaskRoot(env))}`,
    `export AGENT_KIT_REAL_GIT=${shq(realGit)}`,
    `export AGENT_KIT_POLICY_RUNTIME=${shq(process.execPath)}`,
    `export AGENT_KIT_POLICY=${shq(POLICY_PATH)}`,
    `export PATH=${shq(SHIM_DIR)}":$PATH"`,
    "",
  ].join("\n");
}

function hookSessionStart(): number {
  try {
    const envFile = process.env.CLAUDE_ENV_FILE;
    if (!envFile) return 0;
    const lines = sessionStartExports(process.env, process.cwd());
    if (lines) appendFileSync(envFile, lines);
  } catch {
    // Fail open.
  }
  return 0;
}

/** PreToolUse for file-writing tools: the same write/edit verdict the pi
 *  binding's tool_call interceptor returns, as a Claude Code deny. */
export function preToolUseDecision(input: Params, taskRoot: string): Params | null {
  const toolInput = (input.tool_input ?? {}) as Params;
  const target = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
  if (typeof target !== "string" || target === "") return null;
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const verdict = guardManagedWriteTarget(target, cwd, { taskRoot });
  if (!verdict) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: verdict.reason,
    },
  };
}

function hookPreToolUse(): number {
  try {
    const decision = preToolUseDecision(JSON.parse(readStdin()) as Params, resolveTaskRoot());
    if (decision) out(decision);
  } catch {
    // Fail open.
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [op, arg, ...extra] = argv;
  if (op === "hook") {
    if (arg === "session-start") return hookSessionStart();
    if (arg === "pre-tool-use") return hookPreToolUse();
    return usage(`unknown hook '${arg ?? ""}'`);
  }
  if (!op || !(op in FLOWS)) return usage(op ? `unknown operation '${op}'` : "missing operation");
  if (extra.length > 0) return usage("expected a single JSON params argument");

  let params: Params = {};
  const raw = arg === "-" ? readStdin() : arg;
  if (raw !== undefined && raw.trim() !== "") {
    try {
      params = JSON.parse(raw) as Params;
    } catch (e) {
      return usage(`params are not valid JSON: ${(e as Error).message}`);
    }
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      return usage("params must be a JSON object");
    }
  }
  const missing = REQUIRED[op]!.filter((k) => typeof params[k] !== "string" || params[k] === "");
  if (op === "commit" && !Array.isArray(params.paths)) missing.push("paths");
  if (missing.length > 0) return usage(`missing required parameter(s): ${missing.join(", ")}`);

  process.env.PATH = stripShimFromPath(process.env.PATH ?? "");
  try {
    const result = await FLOWS[op]!(params, process.cwd(), resolveTaskRoot());
    out(result);
    return result.status === "error" ? 1 : 0;
  } catch (e) {
    out({ status: "error", message: (e as Error).message });
    return 1;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
