import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** First executable regular file named `git` on PATH. Relative PATH entries
 * are resolved at arm time so the shim always receives an absolute path.
 * When `excludeDir` is given and resolvable, the entry whose directory is
 * that directory (compared by real path, so symlinked install paths still
 * match) is skipped — a nested process inheriting a PATH that already
 * starts with the shim's own directory can never select the shim as real
 * git. Unresolvable `excludeDir` or entries exclude nothing; the lookup
 * stays fail-open. */
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
      return realpathSync(candidate);
    } catch {
      continue;
    }
  }
  return null;
}
