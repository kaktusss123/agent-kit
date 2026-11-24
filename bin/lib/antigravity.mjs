// Antigravity generated plugin artifacts (rules + hooks).
//
// Antigravity loads plugins from `<configRoot>/plugins/<name>/`, merging their
// `rules/AGENTS.md` and `hooks.json` with any global user configuration without
// colliding with an existing `~/.gemini/config/hooks.json` or `AGENTS.md`.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lstatOrNull, statOrNull, writeFileAtomic } from "./io.mjs";
import { shellQuote } from "./codex.mjs";

const HOOK_MATCHER = "run_command|write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content";
const CELLAR_NODE_RE = /^(.+)\/Cellar\/node\/[^/]+\/bin\/node$/;

// Prefer the stable Homebrew bin symlink over a versioned Cellar binary so
// `brew upgrade node` does not break generated hooks.json until reinstall.
export function resolveStableNodePath(execPath = process.execPath) {
	const match = CELLAR_NODE_RE.exec(execPath);
	if (!match) return execPath;
	const linked = `${match[1]}/bin/node`;
	return statOrNull(linked)?.isFile() ? linked : execPath;
}

export function antigravityArtifacts(context) {
	if (context.host !== "antigravity") return [];
	let rules;
	try {
		rules = readFileSync(join(context.repo, "rules/antigravity.md"), "utf8") + "\n\n" +
			readFileSync(join(context.repo, "rules/AGENTS.md"), "utf8");
	} catch (error) {
		// Synthetic/partial repositories may contain skills only.
		if (error.code !== "ENOENT") throw error;
		return [];
	}
	const hooks = JSON.stringify({
		"agent-kit-routing-guard": {
			PreToolUse: [
				{
					matcher: HOOK_MATCHER,
					hooks: [
						{
							type: "command",
							command: `${shellQuote(resolveStableNodePath())} ${shellQuote(join(context.repo, "antigravity/hook.ts"))}`,
							timeout: 10,
						},
					],
				},
			],
		},
	}, null, 2) + "\n";

	return [
		{ rel: "plugins/agent-kit/rules/AGENTS.md", name: "AGENTS.md", content: rules },
		{ rel: "plugins/agent-kit/hooks.json", name: "hooks.json", content: hooks },
	].map(({ rel, name, content }) => {
		const hash = createHash("sha256").update(content).digest("hex");
		return { rel, content, src: join(context.stateDir, "generated-antigravity", `${hash}-${name}`) };
	});
}

export function materializeAntigravityArtifacts(artifacts) {
	for (const { src, content } of artifacts) {
		const existing = lstatOrNull(src);
		if (existing) {
			if (!existing.isFile() || readFileSync(src, "utf8") !== content) {
				throw new Error(`generated Antigravity artifact was changed externally: ${src}`);
			}
		} else {
			writeFileAtomic(src, content);
		}
	}
}
