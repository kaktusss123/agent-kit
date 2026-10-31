// `agent-kit update`: bring the checkout up to date, then reconcile with the
// installer the pull brought.
//
// Git owns the fast-forward semantics (a diverged, dirty or detached checkout is
// refused by git itself, or refused here before git is asked to change
// anything). The reconcile is executed as a fresh process from the updated
// checkout: the code loaded before the pull has just become stale, and running
// it would reconcile links with the previous implementation.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { die, msg, runChild } from "./io.mjs";

function git(repo, args) {
	const result = spawnSync("git", ["-C", repo, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) die(`update: cannot run git: ${result.error.message}`);
	return {
		ok: result.status === 0,
		out: (result.stdout ?? "").trim(),
	};
}

export async function update(repo) {
	if (!git(repo, ["rev-parse", "--git-dir"]).ok) {
		die(`update: ${repo} is not a git checkout; there is nothing to pull`);
	}

	const branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).out;
	if (!branch || branch === "HEAD") {
		die(`update: ${repo} is in detached HEAD state; switch to a branch first`);
	}
	const upstream = git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
		.out;
	if (!upstream) die(`update: branch '${branch}' has no upstream; nothing to pull`);

	msg(`Updating ${repo} (${branch} from ${upstream}):`);
	const pull = spawnSync("git", ["-C", repo, "pull", "--ff-only"], { stdio: "inherit" });
	if (pull.error) die(`update: cannot run git: ${pull.error.message}`);
	if (pull.status !== 0) {
		die(
			`update: 'git pull --ff-only' failed in ${repo}; resolve it manually, then re-run 'agent-kit update'`,
		);
	}

	const installer = join(repo, "bin", "agent-kit");
	return await runChild(installer, ["install"], {
		env: { ...process.env, AGENT_KIT_ROOT: repo },
	});
}
