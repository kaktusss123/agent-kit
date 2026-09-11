/**
 * Result persistence for subagents.
 *
 * One JSON file per agent under the pi agent dir
 * (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`) at `subagents/results/`.
 * Runtime artifacts stay out of the user's working repository. Files are
 * written when an agent reaches a terminal state and read lazily by
 * `subagent result`. The main agent's context never receives this payload
 * automatically.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentResult } from "./types";

export function defaultResultsDir(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "subagents", "results");
}

export function saveResult(result: AgentResult, dir: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${sanitizeId(result.id)}.json`);
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(result, null, "\t"), "utf8");
	fs.renameSync(tmp, file);
	return file;
}

export function loadResult(agentId: string, dir: string): AgentResult | null {
	const file = path.join(dir, `${sanitizeId(agentId)}.json`);
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as AgentResult;
	} catch {
		return null;
	}
}

/** Derive a one-line summary from the child's final assistant text. */
export function summarizeText(finalText: string | undefined, max = 240): string {
	if (!finalText) return "(no final text)";
	const flat = finalText
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.join(" · ");
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function sanitizeId(id: string): string {
	return id.replace(/[^A-Za-z0-9._-]+/g, "_");
}
