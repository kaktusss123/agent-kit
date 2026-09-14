import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** First executable regular file named `git` on PATH. Relative PATH entries
 * are resolved at arm time so the shim always receives an absolute path. */
export function resolveGitOnPath(
  pathValue: string,
  cwd: string = process.cwd(),
): string | null {
  for (const entry of pathValue.split(":")) {
    if (!entry) continue;
    const base = isAbsolute(entry) ? entry : resolve(cwd, entry);
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
