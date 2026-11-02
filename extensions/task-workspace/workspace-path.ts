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
 * This mapping is therefore a reversible escape encoding. The current
 * spelling uses `~` as the escape marker followed by two uppercase hex
 * digits: `/` → `~2F`, `#` → `~23`, `%` → `~25`, `\` → `~5C`, `~` → `~7E`,
 * and (defensively, for inputs no Git ref allows) `?` → `~3F`, space → `~20`.
 * Everything else is copied verbatim.
 *
 * Why `~` and not a percent escape:
 * - `git check-ref-format --branch` refuses `~` in a ref name, so a `~` in a
 *   workspace directory name can only be our marker. It needs no escaping and
 *   cannot be confused with an identity character.
 * - `%` and `#` ARE legal in branch names, so they must be escaped: a raw `%`
 *   in a path component is re-interpreted as percent-encoding (module
 *   loaders reject it: `ERR_INVALID_MODULE_SPECIFIER: ... must not include
 *   encoded "/"`), and a raw `#` truncates a URL at the fragment. The
 *   previous layout encoded with `%2F`-style escapes and was unusable as a
 *   Node working directory for exactly this reason; `~2F` is a plain literal
 *   path component that ESM, URL and shell tooling accept unchanged.
 * - Escaping `/`, `#`, `%`, `\`, `?` and space keeps encoded names inside
 *   `[A-Za-z0-9._~-]` for every identity a Git ref allows.
 *
 * Layouts written by earlier encodings are recognized, never renamed or
 * moved:
 * - `percentTaskWorkspaceName` reproduces the previous (`%2F`) spelling that
 *   shipped before this one;
 * - `legacyTaskWorkspaceName` reproduces the oldest flattening (`/` → `_`);
 * - callers resolve a directory in the order current → previous → oldest, so
 *   an existing workspace stays reachable through its old name. Only a
 *   workspace that does not exist yet is created under the current spelling.
 *
 * `decodeTaskWorkspaceName` inverts both escape spellings and reports a name
 * it did not produce verbatim, so a directory written by the flattening (or
 * made by hand) stays readable as itself instead of being misread as an
 * identity. The flattening is lossy by construction: `feat_a_b` cannot say
 * whether it was `feat/a_b` or `feat_a_b`, which is why those directories are
 * read as their own identity and proven through Git before reuse.
 *
 * Residual ambiguity, deliberately resolved by refusing rather than guessing:
 * a legacy directory whose name happens to spell one of our escapes (a branch
 * literally containing `%2F` or `~2F`) decodes to a different identity.
 * Callers that reuse a pre-existing directory must prove its Git branch first
 * (`ensure_task_repo` does), and a proven mismatch is a refusal, never a
 * takeover.
 */
import { join } from "node:path";

/** Escape marker of the current spelling. `~` is invalid in Git ref names, so
 *  it can never come from an identity and always introduces an escape. */
const MARKER = "~";

const ESCAPES: Record<string, string> = {
  "~": "~7E",
  "%": "~25",
  "/": "~2F",
  "#": "~23",
  "\\": "~5C",
  // Unreachable through a Git ref name; escaped anyway so a hand-supplied
  // identity still produces a path loaders, URLs and shells accept.
  "?": "~3F",
  " ": "~20",
};

const UNESCAPES: Record<string, string> = {
  "7E": "~",
  "25": "%",
  "2F": "/",
  "23": "#",
  "5C": "\\",
  "3F": "?",
  "20": " ",
};

/** Previous (already deployed) spelling: `%`-prefixed escapes. */
const PERCENT_ESCAPES: Record<string, string> = {
  "%": "%25",
  "/": "%2F",
  "\\": "%5C",
};

const PERCENT_UNESCAPES: Record<string, string> = {
  "25": "%",
  "2F": "/",
  "5C": "\\",
};

function escapeWith(identity: string, escapes: Record<string, string>): string {
  let out = "";
  for (const ch of identity) out += escapes[ch] ?? ch;
  return out;
}

/** Undo `marker` + two-hex-digit escapes. Unknown codes stay literal. */
function unescapeWith(
  name: string,
  marker: string,
  unescapes: Record<string, string>,
): string {
  let out = "";
  for (let i = 0; i < name.length; i++) {
    if (name[i] === marker) {
      const code = name.slice(i + 1, i + 3);
      const replacement = code.length === 2 ? unescapes[code] : undefined;
      if (replacement !== undefined) {
        out += replacement;
        i += 2;
        continue;
      }
    }
    out += name[i];
  }
  return out;
}

/** Directory name for a task identity under the current spelling. */
export function encodeTaskWorkspaceName(identity: string): string {
  return escapeWith(identity, ESCAPES);
}

/**
 * Directory name the previous (`%`-escape) layout produced for the same
 * identity. Read-only compatibility: nothing creates these anymore.
 */
export function percentTaskWorkspaceName(identity: string): string {
  return escapeWith(identity, PERCENT_ESCAPES);
}

/**
 * Task identity behind a workspace directory name. Both escape spellings are
 * inverted here; a name neither produced (a flattened pre-encoding directory,
 * a hand-made directory, a foreign escape) is returned unchanged: it is its
 * own identity for lookup purposes.
 */
export function decodeTaskWorkspaceName(name: string): string {
  // Order matters: the current spelling cannot contain a raw `%`, so a name
  // that round-trips through the `~` decoding first is unambiguous.
  const current = unescapeWith(name, MARKER, UNESCAPES);
  if (encodeTaskWorkspaceName(current) === name) return current;
  const previous = unescapeWith(name, "%", PERCENT_UNESCAPES);
  if (percentTaskWorkspaceName(previous) === name) return previous;
  return name;
}

/** Directory name the oldest layout produced for the same identity. */
export function legacyTaskWorkspaceName(identity: string): string {
  return identity.replace(/\//g, "_");
}

export interface TaskWorkspaceLayout {
  /** Directory the identity owns under the current encoding (creation target). */
  directory: string;
  /** Directory the previous (`%`) encoding produced, when it differs. */
  percentDirectory: string | null;
  /** Directory the oldest (`_`) flattening produced, when it differs. */
  legacyDirectory: string | null;
}

/** Directory names for one identity (`<taskRoot>` is applied by the caller). */
export function taskWorkspaceLayout(identity: string): TaskWorkspaceLayout {
  const directory = encodeTaskWorkspaceName(identity);
  const percent = percentTaskWorkspaceName(identity);
  const legacy = legacyTaskWorkspaceName(identity);
  return {
    directory,
    percentDirectory: percent === directory ? null : percent,
    legacyDirectory: legacy === directory ? null : legacy,
  };
}

/** Path form of {@link taskWorkspaceLayout}, joined onto an explicit root. */
export function joinTaskWorkspaceName(taskRoot: string, directory: string): string {
  return join(taskRoot, directory);
}
