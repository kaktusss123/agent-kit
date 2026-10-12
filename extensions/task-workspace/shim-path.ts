import {
  accessSync,
  constants as fsConstants,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** First line of the marker comment inside `shim/git`. */
const SHIM_MARKER = "# task-workspace git PATH shim";

/** Invariant: a task-workspace shim copy — from any install, reached via
 * any symlink path — is never resolved as real git. The shim script starts
 * with a shebang followed by the marker comment, so both of its first two
 * lines are checked against the marker. Unreadable candidates are simply
 * not excluded by content; the lookup stays fail-open. */
export function isShimScript(candidate: string): boolean {
  let content: string;
  try {
    content = readFileSync(candidate, "utf8");
  } catch {
    return false;
  }
  const [first, second] = content.split("\n");
  if (first?.startsWith(SHIM_MARKER)) return true;
  return first?.startsWith("#!") === true && second?.startsWith(SHIM_MARKER) === true;
}

/** First executable regular file named `git` on PATH that is not a
 * task-workspace shim copy. Relative PATH entries are resolved at arm time
 * so the shim always receives an absolute path. A candidate is skipped when
 * its directory is `excludeDir` (compared by real path, so symlinked install
 * paths still match) or when the candidate file itself starts with the shim
 * marker comment, so a nested process inheriting a PATH that contains any
 * shim copy — its own directory's or a foreign install's — can never select
 * it as real git. Unresolvable `excludeDir` or entries, and unreadable
 * candidate files, exclude nothing; the lookup stays fail-open. */
export function resolveGitOnPath(
  pathValue: string,
  cwd: string = process.cwd(),
  excludeDir?: string,
): string | null {
  let excluded: string | null = null;
  if (excludeDir) {
    try {
      excluded = realpathSync(excludeDir);
    } catch {
      excluded = null;
    }
  }
  for (const entry of pathValue.split(":")) {
    if (!entry) continue;
    const base = isAbsolute(entry) ? entry : resolve(cwd, entry);
    if (excluded) {
      try {
        if (realpathSync(base) === excluded) continue;
      } catch {
        // Non-existent entries never match; fall through to the stat check.
      }
    }
    const candidate = join(base, "git");
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      if (isShimScript(candidate)) continue;
      return realpathSync(candidate);
    } catch {
      continue;
    }
  }
  return null;
}
