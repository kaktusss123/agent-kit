/**
 * Pi agent directory resolution, mirroring Pi's `getAgentDir`: an empty
 * `PI_CODING_AGENT_DIR` counts as unset, and a leading `~` / `~/` expands to
 * the home directory. Replicated (not imported) so pure modules and their
 * tests do not load the whole Pi package.
 *
 * Pure module: no pi imports.
 */
import * as os from "node:os";
import * as path from "node:path";

export function resolveAgentDir(env: Record<string, string | undefined> = process.env, home: string = os.homedir()): string {
	const dir = env.PI_CODING_AGENT_DIR;
	if (dir) {
		if (dir === "~") return home;
		if (dir.startsWith("~/")) return path.join(home, dir.slice(2));
		return dir;
	}
	return path.join(home, ".pi", "agent");
}
