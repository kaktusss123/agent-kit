/** Antigravity PreToolUse routing-guard adapter. No Pi runtime dependencies.
 *
 * Reads Antigravity camelCase PreToolUse JSON on stdin and emits:
 * - `{ "decision": "deny", "reason": "..." }` when a file-writing tool targets
 *   the primary checkout of a repository that has managed task worktrees, or
 *   when `run_command` invokes raw `git ... --no-verify`.
 * - Empty stdout (exit 0) otherwise, leaving Antigravity's native permission
 *   and sandbox model untouched (never auto-approving with `decision: "allow"`
 *   and never emitting `{}` which Antigravity parses as an empty decision).
 */
import { readFileSync } from "node:fs";
import { guardManagedWriteTarget } from "../extensions/task-workspace/guard.ts";
import { resolveTaskRoot } from "../extensions/task-workspace/task-root.ts";
import { stripShimFromPath } from "../extensions/task-workspace/cli.ts";

type RecordValue = Record<string, unknown>;

const WRITE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
]);

const NO_VERIFY_RE = /(?:^|[\s;&|(])git(?:\s+(?:-[A-Za-z]|--[a-z-]+(?:=\S+)?|-C\s+\S+))*\s+(?:commit|merge|cherry-pick|revert|am)\b[^;&|\n]*\s(?:--no-verify|-n)(?=\s|$|[;&|)])/;

function deny(reason: string): RecordValue {
  return { decision: "deny", reason };
}

function extractWritePath(args: RecordValue): string | undefined {
  for (const key of ["Path", "TargetFile", "file_path", "path"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

export function decision(input: unknown, opts?: { taskRoot?: string }): RecordValue | null {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const value = input as RecordValue;
    if (value.hookEventName && value.hookEventName !== "PreToolUse") return null;
    const toolCall = value.toolCall as RecordValue | undefined;
    if (!toolCall || typeof toolCall !== "object") return null;
    const name = typeof toolCall.name === "string" ? toolCall.name : "";
    const args = (toolCall.args && typeof toolCall.args === "object" ? toolCall.args : {}) as RecordValue;
    const cwd = typeof value.cwd === "string" && value.cwd ? value.cwd : process.cwd();

    process.env.PATH = stripShimFromPath(process.env.PATH ?? "");

    if (WRITE_TOOLS.has(name)) {
      const target = extractWritePath(args);
      if (!target) return null;
      const taskRoot = opts?.taskRoot ?? resolveTaskRoot();
      const verdict = guardManagedWriteTarget(target, cwd, { taskRoot });
      if (verdict) return deny(verdict.reason);
      return null;
    }

    if (name === "run_command") {
      const cmd = typeof args.CommandLine === "string" ? args.CommandLine : "";
      if (cmd && NO_VERIFY_RE.test(cmd)) {
        return deny(
          "Blocked: raw `git ... --no-verify` bypasses pre-commit hooks. Commit through `agent-kit task commit` (hooks run); for a genuine external hook blocker, retry via `agent-kit task commit` with `deferred_hook` evidence.",
        );
      }
      return null;
    }

    return null;
  } catch {
    // Fail open: routing guard must never deadlock the host session on
    // malformed input or unexpected host payload changes.
    return null;
  }
}

const isEntry = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href ||
      process.argv[1]?.endsWith("antigravity/hook.ts");
  } catch {
    return false;
  }
})();

if (isEntry) {
  try {
    const raw = readFileSync(0, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    const out = decision(parsed);
    if (out) process.stdout.write(JSON.stringify(out) + "\n");
  } catch {
    // Empty stdout = pass through without overriding permissions.
  }
}
