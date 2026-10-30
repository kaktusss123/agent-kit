// Where every installer path comes from.
//
// Hosts, roots, the ownership state directory and the bootstrapped launcher are
// derived from the environment in one place; nothing else in the program reads
// HOME, XDG_STATE_HOME or a host root variable on its own.
//
// Two path predicates guard the ownership state and the desired-state
// description: a destination is relative to a host root and cannot traverse, a
// source is absolute and cannot traverse either. They are intentionally strict
// (no ".." anywhere, not just as a whole segment): state is evidence about
// paths agent-kit may delete, so a path it would never create is a path it must
// never act on.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import { die, statOrNull } from "./io.mjs";

export const HOSTS = ["pi", "claude-code"];

// A recorded destination must name exactly the path it appears to name: no
// traversal, no control characters that a line-based record cannot carry, and
// no segment that path normalization would rewrite. Bash used to concatenate
// "<root>/<rel>" literally, so a row like "victim/." addressed a different
// path than it named; normalizing here instead would widen what a corrupt
// record is allowed to delete, so such rows are dropped.
export function isSafeRel(path) {
	if (path === "" || path.startsWith("/") || path.includes("..")) return false;
	if (/[\t\n\r]/.test(path)) return false;
	return posix.normalize(path) === path;
}

export function isSafeSource(path) {
	if (!path.startsWith("/") || path.includes("..")) return false;
	return !/[\t\n\r]/.test(path);
}

export function isKnownHost(name) {
	return HOSTS.includes(name);
}

// The known hosts among `names`, in HOSTS order and without duplicates, so the
// recorded selection never depends on argument order.
export function hostList(names) {
	return HOSTS.filter((host) => names.includes(host));
}

export function validateHosts(names) {
	for (const name of names) {
		if (!isKnownHost(name)) die(`unknown host: '${name}' (hosts: ${HOSTS.join(" ")})`);
	}
}

// Resolve the checkout that owns this executable: through the script's own
// symlinks first (the bootstrapped launcher is a symlink into a checkout), then
// git's idea of the top level, then the parent of bin/. AGENT_KIT_ROOT exists
// for tests and sandboxes and is taken verbatim, exactly as recorded sources
// are compared against it.
export function resolveRepository(script) {
	const scriptDir = dirname(script);
	let repo;
	try {
		repo = execFileSync("git", ["-C", scriptDir, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		repo = join(scriptDir, "..");
	}
	if (!repo) repo = join(scriptDir, "..");
	try {
		repo = realpathSync(repo);
	} catch {
		die(`repository root not found: ${repo}`);
	}
	const override = process.env.AGENT_KIT_ROOT;
	if (override) repo = override;
	if (!statOrNull(repo)?.isDirectory()) die(`repository root not found: ${repo}`);
	return repo;
}

export function resolvePaths(entryPath) {
	const env = process.env;
	let entry;
	try {
		entry = realpathSync(entryPath);
	} catch {
		die(`cannot resolve the executable path: ${entryPath}`);
	}
	const home = env.HOME || homedir();
	const stateHome = env.XDG_STATE_HOME || join(home, ".local", "state");
	const stateDir = join(stateHome, "agent-kit");
	const piRoot = env.PI_AGENT_DIR || join(home, ".pi", "agent");
	const claudeRoot = env.CLAUDE_CONFIG_DIR || join(home, ".claude");

	// pi keeps links.tsv for compatibility with installs made before the second
	// host existed; every other host gets its own file.
	const linkStateFile = (host) =>
		host === "pi" ? join(stateDir, "links.tsv") : join(stateDir, `links-${host}.tsv`);

	const repo = resolveRepository(entry);

	return {
		repo,
		entry,
		home,
		stateDir,
		selectionFile: join(stateDir, "hosts"),
		commandFile: join(stateDir, "command.tsv"),
		launcher: join(home, ".local", "bin", "agent-kit"),
		linkStateFile,
		hostContext(host) {
			if (!isKnownHost(host)) die(`unknown host: ${host}`);
			const root = host === "pi" ? piRoot : claudeRoot;
			return { host, root, repo, stateFile: linkStateFile(host) };
		},
	};
}
