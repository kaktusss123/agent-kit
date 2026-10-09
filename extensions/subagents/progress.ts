/** Bounded progress handoff, independent from the final report's freshness. */
import * as fs from "node:fs";
import * as path from "node:path";

export interface ProgressInput {
	achieved: string;
	currentWork: string;
	blocker?: string;
	nextStep: string;
}
export interface Progress extends ProgressInput {
	/** Unix milliseconds assigned by the runtime, never accepted from the agent. */
	updatedAt: number;
}
const INPUT_KEYS = new Set(["achieved", "currentWork", "blocker", "nextStep"]);
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export function validateProgressInput(value: unknown): ProgressInput | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const v = value as Record<string, unknown>;
	if (Object.keys(v).some((k) => !INPUT_KEYS.has(k))) return undefined;
	for (const key of ["achieved", "currentWork", "nextStep", ...(v.blocker !== undefined ? ["blocker"] : [])]) {
		if (typeof v[key] !== "string" || (v[key] as string).length > 1000) return undefined;
	}
	const normalize = (s: string) => s.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
	return {
		achieved: normalize(v.achieved as string), currentWork: normalize(v.currentWork as string),
		nextStep: normalize(v.nextStep as string),
		...(v.blocker !== undefined ? { blocker: normalize(v.blocker as string) } : {}),
	};
}

export function validateProgress(value: unknown): Progress | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const { updatedAt, ...input } = value as Record<string, unknown>;
	if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt < 0) return undefined;
	const checked = validateProgressInput(input);
	return checked ? { ...checked, updatedAt } : undefined;
}

export function progressFileName(agentId: string): string {
	return `progress-${agentId.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`;
}

export function saveProgress(agentId: string, input: unknown, dir: string): Progress {
	const checked = validateProgressInput(input);
	if (!checked) throw new Error("invalid progress: closed payload, required strings, maximum 1000 characters each");
	const progress: Progress = { ...checked, updatedAt: Date.now() };
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, progressFileName(agentId));
	fs.writeFileSync(`${file}.tmp`, JSON.stringify({ agentId, progress }), "utf8");
	fs.renameSync(`${file}.tmp`, file);
	return progress;
}

export function loadProgress(agentId: string, dir: string): Progress | undefined {
	try {
		const file = path.join(dir, progressFileName(agentId));
		// Bound reads too: malformed files must never become transcript-sized telemetry.
		if (fs.statSync(file).size > 32000) return undefined;
		const record = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!record || record.agentId !== agentId || Object.keys(record).some((k) => k !== "agentId" && k !== "progress")) return undefined;
		return validateProgress(record.progress);
	} catch {
		return undefined;
	}
}

/** The single compact run projection, used by live inspection and persisted history. */
export interface RunHistory {
	workspace: string;
	state: string;
	deadlineAt?: number;
	progress?: Progress;
	status?: "done" | "partial" | "blocked";
	terminal?: {
		status: "done" | "partial" | "blocked";
		reason?: string;
		result?: { status: "done" | "partial" | "blocked"; summary: string };
	};
}
