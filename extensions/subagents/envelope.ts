/**
 * Envelope schema and file handoff for workspace_agent runs.
 *
 * The RepoOwner child reports its product outcome through the `report_result`
 * tool (reporting-bridge.ts), which validates params against the typebox
 * schema (envelope-schema.ts) and atomically writes an EnvelopeRecord under
 * its agentId. The main-side workspace layer re-reads and re-validates the
 * same file at settlement — this module is the single shared contract and
 * stays free of typebox/pi imports so bun unit tests can use it directly.
 *
 * Staleness ("finish by reporting" as a mechanical property): the bridge
 * invalidates the record as soon as any other tool call follows a successful
 * report, by rewriting the record with `stale: true`. Settlement accepts only
 * fresh (existing, valid, non-stale) envelopes. Generation counters live in
 * the bridge; this module is stateless.
 */

export const EnvelopeStatus = ["done", "partial", "blocked"] as const;
export const VerificationResult = ["pass", "fail", "blocked"] as const;

export type Envelope = {
	status: (typeof EnvelopeStatus)[number];
	summary: string;
	changed_scope: string[];
	verification: Array<{
		check: string;
		cwd?: string;
		result: (typeof VerificationResult)[number];
	}>;
	gaps: string[];
	contract_conflicts?: string[];
};

/**
 * Durable envelope record: what the bridge writes, what settlement reads.
 * `generation` counts successful reports in the child; `stale` is flipped by
 * the bridge as soon as any later tool call invalidates the last report.
 */
export interface EnvelopeRecord {
	agentId: string;
	generation: number;
	stale: boolean;
	reportedAt: number;
	envelope: Envelope;
}

const ENVELOPE_KEYS = new Set(["status", "summary", "changed_scope", "verification", "gaps", "contract_conflicts"]);
const VERIFICATION_KEYS = new Set(["check", "cwd", "result"]);

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((s) => typeof s === "string");
}

/**
 * Structural validation mirroring envelope-schema.ts (identical semantics,
 * including additionalProperties:false). Returns the typed envelope, or
 * undefined when invalid.
 */
export function validateEnvelope(value: unknown): Envelope | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) {
		if (!ENVELOPE_KEYS.has(key)) return undefined;
	}
	if (typeof v.status !== "string" || !(EnvelopeStatus as readonly string[]).includes(v.status)) return undefined;
	if (typeof v.summary !== "string") return undefined;
	if (!isStringArray(v.changed_scope)) return undefined;
	if (!isStringArray(v.gaps)) return undefined;
	if (v.contract_conflicts !== undefined && !isStringArray(v.contract_conflicts)) return undefined;
	if (!Array.isArray(v.verification)) return undefined;
	for (const item of v.verification) {
		if (typeof item !== "object" || item === null) return undefined;
		const check = item as Record<string, unknown>;
		for (const key of Object.keys(check)) {
			if (!VERIFICATION_KEYS.has(key)) return undefined;
		}
		if (typeof check.check !== "string") return undefined;
		if (check.cwd !== undefined && typeof check.cwd !== "string") return undefined;
		if (typeof check.result !== "string" || !(VerificationResult as readonly string[]).includes(check.result)) {
			return undefined;
		}
	}
	return v as unknown as Envelope;
}

export function validateEnvelopeRecord(value: unknown): EnvelopeRecord | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const v = value as Record<string, unknown>;
	if (typeof v.agentId !== "string") return undefined;
	if (typeof v.generation !== "number" || !Number.isFinite(v.generation)) return undefined;
	if (typeof v.stale !== "boolean") return undefined;
	if (typeof v.reportedAt !== "number" || !Number.isFinite(v.reportedAt)) return undefined;
	const envelope = validateEnvelope(v.envelope);
	if (!envelope) return undefined;
	return {
		agentId: v.agentId,
		generation: v.generation,
		stale: v.stale,
		reportedAt: v.reportedAt,
		envelope,
	};
}

/** File name of the envelope record for one agent inside the results dir. */
export function envelopeFileName(agentId: string): string {
	return `envelope-${sanitizeId(agentId)}.json`;
}

function sanitizeId(id: string): string {
	return id.replace(/[^A-Za-z0-9._-]+/g, "_");
}
