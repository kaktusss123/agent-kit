/**
 * Reporting bridge — additional extension entry for RepoOwner children.
 *
 * Loaded per-spawn via `additionalExtensions` next to the shared base bridge
 * (which keeps providing ask_parent). Adds exactly one capability:
 * `report_result`, the trusted structured outcome channel of the
 * workspace_agent protocol.
 *
 * Semantics:
 * - The tool validates params against the envelope schema (typebox) and
 *   atomically writes an EnvelopeRecord (tmp+rename) under the child's
 *   agentId into the shared results dir. Invalid calls fail the tool call.
 * - Staleness: after a successful report, ANY later tool call (except
 *   report_result itself) invalidates the record — it is rewritten with
 *   `stale: true`. Settlement on the main side accepts only fresh records,
 *   so "finish by reporting" is a mechanical property, not an instruction.
 * - Readiness: reports the registered tool set to the controller through the
 *   shared readiness handshake (signalChildReadiness).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EnvelopeSchema } from "./envelope-schema";
import { envelopeFileName, type Envelope, type EnvelopeRecord } from "./envelope";
import { signalChildReadiness } from "./readiness";

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

	const writeRecord = (record: EnvelopeRecord): void => {
		const dir = resultsDir();
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, envelopeFileName(record.agentId));
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(record, null, "\t"), "utf8");
		fs.renameSync(tmp, file);
	};

	// Staleness hook: any tool call other than a fresh report invalidates the
	// last report (guard and other extension tools included). Runs before the
	// tool executes, so the envelope is already stale if the call has effects.
	pi.on("tool_call", (event) => {
		if (!reported) return;
		if (event.toolName === "report_result") return;
		reported = false;
		try {
			writeRecord({
				agentId,
				generation,
				stale: true,
				reportedAt: Date.now(),
				envelope: lastEnvelope,
			});
		} catch {
			// If the stale flip cannot be written, the last report stays as it
			// was; settlement reads the file, not this process's memory.
		}
	});

	pi.registerTool({
		name: "report_result",
		label: "Report Result",
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

	signalChildReadiness(pi, REPORTING_ENTRY_ID, ["report_result"]);
}
