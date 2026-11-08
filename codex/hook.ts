/** Codex rust-v0.166.0 PreToolUse adapter. No Pi runtime dependencies.
 * Bash is exec_command's canonical hook name; native apply_patch also carries
 * tool_input.command. input.cwd is the actual tool cwd, not session cwd.
 * https://github.com/openai/codex/tree/rust-v0.166.0/codex-rs/hooks/src/events
 */
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { guardManagedWriteTarget } from "../extensions/task-workspace/guard.ts";
import { sessionStartExports, stripShimFromPath } from "../extensions/task-workspace/cli.ts";
import { resolveTaskRoot } from "../extensions/task-workspace/task-root.ts";

type RecordValue = Record<string, unknown>;
function deny(reason: string): RecordValue {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

export function patchPaths(patch: string): string[] {
  const lines = patch.trim().split("\n");
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") throw new Error("invalid patch framing");
  const paths: string[] = [];
  let operation = "";
  let moved = false;
  for (const line of lines.slice(1, -1)) {
    const header = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(line);
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (header) {
      operation = header[1]!;
      moved = false;
      paths.push(header[2]!.trim());
    } else if (move) {
      if (operation !== "Update" || moved) throw new Error("unexpected patch move");
      paths.push(move[1]!.trim());
      moved = true;
    } else if (line.startsWith("***") && line !== "*** End of File") throw new Error("unknown patch header");
  }
  if (!paths.length || paths.some((path) => !path.trim() || /[\r\n\0]/.test(path) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path))) {
    throw new Error("invalid or missing patch path");
  }
  return paths;
}

export function decision(input: unknown): RecordValue {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("expected an object");
    const value = input as RecordValue;
    if (value.hook_event_name !== "PreToolUse") throw new Error("expected PreToolUse");
    if (typeof value.cwd !== "string" || !isAbsolute(value.cwd)) throw new Error("missing absolute tool cwd");
    const tool = value.tool_input as RecordValue | undefined;
    if (!tool || typeof tool.command !== "string" || !tool.command.trim()) throw new Error("missing tool_input.command");
    // Policy subprocesses must resolve real Git, not recursively enter a shim.
    process.env.PATH = stripShimFromPath(process.env.PATH ?? "");
    if (value.tool_name === "Bash") {
      const prefix = sessionStartExports(process.env, value.cwd);
      if (!prefix) throw new Error("cannot resolve real Git for the routing shim");
      return { hookSpecificOutput: {
        hookEventName: "PreToolUse", permissionDecision: "allow",
        updatedInput: { command: prefix + tool.command },
      } };
    }
    if (value.tool_name !== "apply_patch") throw new Error("unsupported hook tool");
    for (const path of patchPaths(tool.command)) {
      const verdict = guardManagedWriteTarget(path, value.cwd, { taskRoot: resolveTaskRoot() });
      if (verdict) return deny(verdict.reason);
    }
    return {};
  } catch (error) {
    return deny(`Blocked: Codex routing adapter could not validate this tool input: ${(error as Error).message}. Use the managed task worktree or report the blocker.`);
  }
}

try {
  process.stdout.write(JSON.stringify(decision(JSON.parse(readFileSync(0, "utf8")))) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify(deny(`Blocked: invalid Codex hook JSON: ${(error as Error).message}`)) + "\n");
}
