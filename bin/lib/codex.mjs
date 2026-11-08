// Codex has two explicit ownership roots. Only generated immutable config
// artifacts live in state; no user config or trust settings are edited.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lstatOrNull, writeFileAtomic } from "./io.mjs";

export function shellQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function codexArtifacts(context) {
	if (context.host !== "codex" || context.scope !== "config") return [];
	let rules;
	try {
		rules = readFileSync(join(context.repo, "rules/codex.md"), "utf8") + "\n\n" +
			readFileSync(join(context.repo, "rules/AGENTS.md"), "utf8");
	} catch (error) {
		// Synthetic/partial repositories may contain skills only.
		if (error.code !== "ENOENT") throw error;
		return [];
	}
	const hooks = JSON.stringify({ hooks: { PreToolUse: [{
		matcher: "^(Bash|apply_patch)$",
		hooks: [{ type: "command", command: `${shellQuote(process.execPath)} ${shellQuote(join(context.repo, "codex/hook.ts"))}`, timeout: 10 }],
	}] } }, null, 2) + "\n";
	return [{ rel: "AGENTS.md", content: rules }, { rel: "hooks.json", content: hooks }].map((entry) => {
		const hash = createHash("sha256").update(entry.content).digest("hex");
		return { ...entry, src: join(context.stateDir, "generated-codex", `${hash}-${entry.rel}`) };
	});
}

export function materializeCodexArtifacts(artifacts) {
	for (const { src, content } of artifacts) {
		const existing = lstatOrNull(src);
		if (existing) {
			if (!existing.isFile() || readFileSync(src, "utf8") !== content) {
				throw new Error(`generated Codex artifact was changed externally: ${src}`);
			}
		} else writeFileAtomic(src, content);
	}
}
