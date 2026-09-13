/**
 * task-root — shared task-root resolution policy, owned by the task
 * subsystem itself (not by any harness binding).
 *
 * One task identity must resolve to one filesystem location for every
 * harness (OMP, pi, OpenCode, ...). Harness bindings call resolveTaskRoot()
 * and pass the result into the host-independent core; they never compute a
 * filesystem layout themselves.
 *
 * Precedence:
 *   1. `AGENT_TASK_ROOT` — generic shared task-root configuration
 *      (recommended; harness-agnostic);
 *   2. `OMP_TASK_ROOT` — legacy compatibility alias, still honored so
 *      existing installations keep working. Never recommend it in new code
 *      or documentation; the generic name always wins when both are set;
 *   3. Default `~/.omp/tasks` — the historical location, kept as the
 *      backward-compatible default so existing task directories are never
 *      silently orphaned. Machines that want a different layout set
 *      `AGENT_TASK_ROOT` explicitly.
 *
 * No automatic migration: an existing root is resolved as-is, never moved.
 *
 * This module intentionally reads the environment (that is its whole job);
 * every other core module stays env-free and receives the resolved root
 * explicitly. It must not import any harness SDK.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { realpath } from "./git";

type Env = Record<string, string | undefined>;

/** `~` and `~/...` expand against the user's home directory. */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Resolve the shared task workspace root. `env` defaults to `process.env`
 * but is a parameter so tests (and future config layers) can resolve
 * without touching ambient state.
 *
 * Uses the non-throwing core realpath: a configured root that does not
 * exist yet (fresh install, first task not created) stays a stable path
 * instead of throwing out of module/registration init.
 */
export function resolveTaskRoot(env: Env = process.env): string {
  const generic = env.AGENT_TASK_ROOT?.trim();
  if (generic) return realpath(expandTilde(generic));
  const legacy = env.OMP_TASK_ROOT?.trim();
  if (legacy) return realpath(expandTilde(legacy));
  return realpath(join(homedir(), ".omp", "tasks"));
}
