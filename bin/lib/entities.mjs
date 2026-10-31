// Desired state: the repository layout is the manifest.
//
// Every category contributes its top-level entries by name, plus the single
// canonical files and directories listed per host. A category that does not
// exist in the checkout contributes nothing, so a partial tree (tests, a
// stripped sandbox) still installs exactly what it has.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { die, statOrNull, warn } from "./io.mjs";
import { isSafeRel } from "./paths.mjs";

// Shell glob `*` semantics: dotfiles are not entities, and an entry whose
// target does not resolve (a dangling symlink inside the checkout) is not
// installable. Order is the locale-independent byte order of the names, which
// keeps the printed reconcile transcript deterministic.
function topLevelEntries(dir) {
	let names;
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const entries = [];
	for (const name of names.sort()) {
		if (name.startsWith(".")) continue;
		if (/[\t\n\r]/.test(name)) {
			// Ownership is a line-based record; a name that would break the
			// record's framing can never be owned safely, so it is never linked.
			warn(`skipping entity whose name has a control character: ${JSON.stringify(name)}`);
			continue;
		}
		const abs = join(dir, name);
		if (!statOrNull(abs)) continue;
		entries.push({ name, abs });
	}
	return entries;
}

function category(repo, sourceDir, destDir) {
	return topLevelEntries(join(repo, sourceDir)).map(({ name, abs }) => ({
		rel: `${destDir}/${name}`,
		src: abs,
	}));
}

function single(repo, sourceRel, destRel, kind) {
	const abs = join(repo, sourceRel);
	const stat = statOrNull(abs);
	if (!stat) return [];
	if (kind === "file" && !stat.isFile()) return [];
	if (kind === "dir" && !stat.isDirectory()) return [];
	return [{ rel: destRel, src: abs }];
}

export function desiredEntities(host, repo) {
	const entities = category(repo, "skills", "skills");
	if (host === "pi") {
		entities.push(...category(repo, "extensions", "extensions"));
		entities.push(...category(repo, "prompts", "prompts"));
		entities.push(...single(repo, "rules/AGENTS.md", "AGENTS.md", "file"));
		return entities;
	}
	if (host === "claude-code") {
		entities.push(...single(repo, "rules/AGENTS.md", "rules/agent-kit.md", "file"));
		entities.push(
			...single(repo, "rules/claude-code.md", "rules/agent-kit-claude-code.md", "file"),
		);
		// Skills-directory plugin: Claude Code loads it in place, so the whole
		// plugin directory is one entity.
		entities.push(...single(repo, "claude-code/plugin", "skills/agent-kit", "dir"));
		entities.push(...category(repo, "claude-code/commands", "commands"));
		entities.push(...category(repo, "claude-code/agents", "agents"));
		return entities;
	}
	die(`unknown host: ${host}`);
}

// Nothing outside the checkout may become a managed link, and nothing inside it
// may be linked to a traversing destination. Checked for the whole desired set
// before the first filesystem change.
export function validateEntity(repo, { rel, src }) {
	if (!isSafeRel(rel)) die(`unsafe destination path: '${rel}'`);
	if (/[\t\n\r]/.test(src)) die(`unsafe source path: '${src}'`);
	// AGENT_KIT_ROOT is taken verbatim, so a trailing slash is part of it.
	const prefix = repo.endsWith("/") ? repo : `${repo}/`;
	if (!src.startsWith(prefix)) die(`source outside the repository: '${src}'`);
}
