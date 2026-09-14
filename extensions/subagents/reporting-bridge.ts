/**
 * Reporting bridge — additional extension entry for RepoOwner children.
 *
 * Loaded per-spawn via `additionalExtensions` next to the shared base bridge
 * (which keeps providing `ask`). Adds exactly one capability:
 * `report_result`, the trusted structured outcome channel of the
 * workspace-mode (RepoOwner) protocol.
 *
 * Semantics:
 * - The tool validates params against the envelope schema (typebox) and
 *   atomically writes an EnvelopeRecord (tmp+rename) under the child's
 *   agentId into the shared results dir. Invalid calls fail the tool call.
 * - Staleness: after a successful report, ANY later tool call (except
 *   report_result itself) invalidates the record — it is rewritten with
 *   `stale: true`. Settlement on the main side accepts only fresh records,
 *   so "finish by reporting" is a mechanical property, not an instruction.
 * - Readiness: none. The bridge declares nothing about readiness — the
 *   subagents-owned readiness probe observes this entry against the
 *   controller's contract (see readiness.ts / readiness-probe.ts).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EnvelopeSchema } from "./envelope-schema";
import {
	envelopeFileName,
	validateEnvelopeRecord,
	type Envelope,
	type EnvelopeRecord,
} from "./envelope";

/** Entry id of this extension in the spawn readiness contract. */
export const REPORTING_ENTRY_ID = "workspace-reporting";

/** Env var the controller sets to hand the child the shared results dir. */
const RESULTS_DIR_ENV = "PI_SUBAGENT_RESULTS_DIR";

export default function (pi: ExtensionAPI) {
	const agentId = process.env.PI_SUBAGENT_ID ?? "";
	let generation = 0;
	let reported = false;
	let lastEnvelope: Envelope;

	const resultsDir = (): string => {
		if (process.env[RESULTS_DIR_ENV]) return process.env[RESULTS_DIR_ENV] as string;
		const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
		return path.join(agentDir, "subagents", "results");
	};

	const envelopePath = (): string => path.join(resultsDir(), envelopeFileName(agentId));

	const readRecord = (): EnvelopeRecord | undefined => {
		try {
			return validateEnvelopeRecord(JSON.parse(fs.readFileSync(envelopePath(), "utf8")));
		} catch {
			return undefined;
		}
	};

	const writeRecord = (record: EnvelopeRecord): void => {
		fs.mkdirSync(resultsDir(), { recursive: true });
		const file = envelopePath();
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(record, null, "\t"), "utf8");
		fs.renameSync(tmp, file);
	};

	/**
	 * Mark the current on-disk record stale, preserving its content. Fails
		 * loudly (throws) so callers can fail closed instead of leaving a stale
		 * report trusted.
	 */
	const staleOnDisk = (): void => {
		const current = readRecord();
		if (current && !current.stale) {
			writeRecord({ ...current, stale: true, reportedAt: current.reportedAt });
		}
	};

	// Staleness hook: any tool call other than a fresh report invalidates the
	// last report (guard and other extension tools included). Runs before the
	// tool executes. FAIL CLOSED: if the invalidation cannot be persisted, the
	// call is blocked — executing it would leave a stale report trusted.
	pi.on("tool_call", (event) => {
		if (!reported) return;
		if (event.toolName === "report_result") return;
		try {
			staleOnDisk();
		} catch {
			// Keep `reported` true so later calls keep retrying the
			// invalidation instead of silently sailing through.
			return {
				block: true,
				reason:
					"Blocked: the previous report_result envelope could not be invalidated on disk (persist failed). " +
					"Call report_result again to re-report, or finish without further tool calls — proceeding would " +
					"leave a stale report trusted by the main side.",
			};
		}
		reported = false;
	});

	pi.registerTool({
		name: "report_result",
		label: "Report Result",
		// Sequential execution: if the model batches [mutation, report_result]
		// in one assistant message, the mutation must complete BEFORE the
		// report is written, or the envelope would describe pre-mutation
		// state while already marked fresh. One sequential tool in a batch
		// makes pi run the whole batch sequentially.
		executionMode: "sequential",
		description:
			"Report your final structured outcome for this workspace task. Call exactly once, as your LAST action, " +
			"after all verification is done. Any tool call after reporting invalidates the report, so report only " +
			"when nothing else is left to do. Required: status (done|partial|blocked), summary, changed_scope, " +
			"verification checks (with pass/fail/blocked results), gaps.",
		parameters: EnvelopeSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!agentId) {
				return {
					content: [{ type: "text" as const, text: "Error: report_result requires PI_SUBAGENT_ID" }],
					details: { error: "missing PI_SUBAGENT_ID" },
					isError: true,
				};
			}
			// Replacement ordering (fail closed): stale the previous on-disk
			// report BEFORE writing the fresh one. If the fresh write then
			// fails, the disk holds a stale record — never the previous
			// trusted report masquerading as current.
			if (reported) {
				try {
					staleOnDisk();
				} catch (e) {
					return {
						content: [
							{
								type: "text" as const,
								text:
									"Error: could not invalidate the previous report on disk: " +
									(e instanceof Error ? e.message : String(e)) +
									". Nothing was replaced; retry report_result.",
							},
						],
						details: { error: "stale-before-replace failed" },
						isError: true,
					};
				}
			}
			const record: EnvelopeRecord = {
				agentId,
				generation: ++generation,
				stale: false,
				reportedAt: Date.now(),
				envelope: params,
			};
			try {
				writeRecord(record);
			} catch (e) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: failed to persist the report: ${e instanceof Error ? e.message : String(e)}`,
						},
					],
					details: { error: "persist failed" },
					isError: true,
				};
			}
			reported = true;
			lastEnvelope = params;
			return {
				content: [
					{
						type: "text" as const,
						text:
							"Report recorded. It stays valid only as long as you make no further tool calls — " +
							"if you keep working, report again when done.",
					},
				],
				details: { reported: true, generation },
			};
		},
	});
}
