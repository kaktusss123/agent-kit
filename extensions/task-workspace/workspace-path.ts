/**
 * task workspace directory names — task identity to filesystem path.
 *
 * One task identity (the branch name of the canonical call, or the `task`
 * argument of a lane call) must map to exactly ONE directory, and two
 * different identities must never map to the same directory. A lossy
 * transformation (replacing "/" with "_") violates the second half:
 * `feat/a_b` and `feat/a/b` both became `feat_a_b`, so two different tasks
 * could share one worktree directory.
 *
 * The mapping here is a reversible escape encoding: `%` → `%25`,
 * `/` → `%2F`, `\` → `%5C`. Everything else is copied verbatim, so an
 * identity without separators keeps its historical directory name and every
 * existing workspace stays exactly where it is.
 *
 * Layouts written before this encoding are recognized, never renamed
 * silently:
 * - `legacyTaskWorkspaceName` reproduces the old flattening, so callers can
 *   look for a pre-encoding directory and prove it belongs to the requested
 *   identity before reusing it;
 * - `decodeTaskWorkspaceName` is the inverse of the encoding and reports a
 *   name it did not produce verbatim, so a legacy (or hand-made) directory
 *   name stays readable as itself instead of being misread as an identity.
 *
 * Residual ambiguity, deliberately resolved by refusing rather than guessing:
 * a legacy directory whose name happens to spell one of our escapes (a branch
 * literally containing `%2F`) decodes to a different identity. Callers that
 * reuse a pre-existing directory must prove its Git branch first
 * (`ensure_task_repo` does), and a proven mismatch is a refusal, never a
 * takeover.
 */
import { join } from "node:path";

const ESCAPES: Record<string, string> = {
  "%": "%25",
  "/": "%2F",
  "\\": "%5C",
};

const UNESCAPES: Record<string, string> = {
  "%25": "%",
  "%2F": "/",
  "%5C": "\\",
};

/** Directory name for a task identity (reversible, collision-free). */
export function encodeTaskWorkspaceName(identity: string): string {
  let out = "";
  for (const ch of identity) out += ESCAPES[ch] ?? ch;
  return out;
}

/**
 * Task identity behind a workspace directory name. A name this encoding did
 * not produce (a pre-encoding directory, a hand-made directory) is returned
 * unchanged: it is its own identity for lookup purposes.
 */
export function decodeTaskWorkspaceName(name: string): string {
  if (!name.includes("%")) return name;
  let decoded = "";
  for (let i = 0; i < name.length; i++) {
    const escape = name.slice(i, i + 3);
    const replacement = UNESCAPES[escape];
    if (replacement !== undefined && escape.length === 3) {
      decoded += replacement;
      i += 2;
      continue;
    }
    decoded += name[i];
  }
  // Only an exact round-trip is our encoding; anything else is a foreign name.
  return encodeTaskWorkspaceName(decoded) === name ? decoded : name;
}

/** Directory name the pre-encoding layout produced for the same identity. */
export function legacyTaskWorkspaceName(identity: string): string {
  return identity.replace(/\//g, "_");
}

export interface TaskWorkspaceLayout {
  /** Directory the identity owns under the current encoding. */
  directory: string;
  /** Pre-encoding directory for the same identity, when it differs. */
  legacyDirectory: string | null;
}

/** Directory names for one identity (`<taskRoot>` is applied by the caller). */
export function taskWorkspaceLayout(identity: string): TaskWorkspaceLayout {
  const directory = encodeTaskWorkspaceName(identity);
  const legacyDirectory = legacyTaskWorkspaceName(identity);
  return { directory, legacyDirectory: legacyDirectory === directory ? null : legacyDirectory };
}

/** Path form of {@link taskWorkspaceLayout}, joined onto an explicit root. */
export function joinTaskWorkspaceName(taskRoot: string, directory: string): string {
  return join(taskRoot, directory);
}
