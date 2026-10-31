// `agent-kit task`: the task-workspace CLI for hosts without Pi extensions.
//
// The TypeScript core under extensions/task-workspace owns its JSON contract,
// so this command only locates it and hands it the arguments verbatim: stdout
// must stay exactly one JSON object, and the exit code of the runtime is the
// exit code of the command.
//
// The runtime is the Node.js process that runs this dispatcher: no PATH
// lookup, no second interpreter, no build step. `extensions/task-workspace`
// is written in the erasure-only subset of TypeScript and imports its
// siblings with explicit `.ts` extensions, so Node executes the sources
// directly.
//
// Hooks fail open: a checkout without the CLI must never disturb the host
// session, so a hook succeeds silently, while an explicit operation reports
// the missing CLI as JSON on stdout.

import { join } from "node:path";
import { runChild, statOrNull, writeStdout } from "./io.mjs";

function taskError(message) {
	writeStdout(`${JSON.stringify({ status: "error", message })}\n`);
}

export function task(repo, args) {
	const cli = join(repo, "extensions", "task-workspace", "cli.ts");
	if (statOrNull(cli)?.isFile() !== true) {
		if (args[0] === "hook") return 0;
		taskError(`task-workspace CLI missing: ${cli}`);
		return 1;
	}
	return runChild(process.execPath, [cli, ...args]);
}
