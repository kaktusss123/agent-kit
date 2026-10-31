// `agent-kit task`: the task-workspace CLI for hosts without Pi extensions.
//
// The TypeScript core under extensions/task-workspace runs on Bun and owns its
// JSON contract, so this command only locates it and hands it the arguments
// verbatim: stdout must stay exactly one JSON object, and the exit code of the
// runtime is the exit code of the command.
//
// Hooks fail open: a missing runtime must never disturb the host session, so a
// hook without Bun succeeds silently, while an explicit operation reports the
// missing runtime as JSON on stdout.

import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, join } from "node:path";
import { runChild, statOrNull, writeStdout } from "./io.mjs";

function findExecutable(name) {
	const path = process.env.PATH ?? "";
	for (const component of path.split(delimiter)) {
		// An empty PATH component means the current directory, as in a shell.
		const dir = component === "" ? "." : component;
		const candidate = join(dir, name);
		if (statOrNull(candidate)?.isFile() !== true) continue;
		try {
			accessSync(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			continue;
		}
	}
	return "";
}

function taskError(message) {
	writeStdout(`{"status":"error","message":"${message}"}\n`);
}

export function task(repo, args) {
	const bun = findExecutable("bun");
	if (!bun) {
		if (args[0] === "hook") return 0;
		taskError("agent-kit task requires bun on PATH");
		return 1;
	}
	const cli = join(repo, "extensions", "task-workspace", "cli.ts");
	if (statOrNull(cli)?.isFile() !== true) {
		taskError(`task-workspace CLI missing: ${cli}`);
		return 1;
	}
	return runChild(bun, [cli, ...args]);
}
