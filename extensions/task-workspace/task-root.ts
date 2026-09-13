/**
 * task-root — task-root resolution policy, owned by the task subsystem.
 *
 * One task identity must resolve to one filesystem location. The pi
 * binding calls resolveTaskRoot() and passes the result into the
 * host-independent core; nothing else computes a filesystem layout.
 *
 * Precedence:
 *   1. `AGENT_TASK_ROOT` — explicit override;
 *   2. Default `~/.agent-kit/tasks`.
 *
 * `~` and `~/...` expand against the user's home directory. A configured
 * root that does not exist yet stays a stable path instead of throwing
 * out of module/registration init (non-throwing realpath walk-up), and a
 * symlinked root resolves to its real path.
 *
 * No automatic migration from any earlier default location: an existing
 * root is resolved as-is, never moved.
 *
 * This module intentionally reads the environment (that is its whole job);
 * every other core module stays env-free and receives the resolved root
 * explicitly. It must not import the pi SDK.
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
 * Resolve the task workspace root. `env` defaults to `process.env`
 * but is a parameter so tests can resolve without touching ambient state.
 *
 * Uses the non-throwing core realpath: a configured root that does not
 * exist yet (fresh install, first task not created) stays a stable path.
 */
export function resolveTaskRoot(env: Env = process.env): string {
  const override = env.AGENT_TASK_ROOT?.trim();
  if (override) return realpath(expandTilde(override));
  return realpath(join(homedir(), ".agent-kit", "tasks"));
}
