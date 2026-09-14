/**
 * TypeBox schema for the workspace-mode report envelope.
 *
 * The canonical machine-checkable artifact of the envelope contract: the
 * reporting bridge passes it to pi's tool registration (pi validates
 * `report_result` params against it before execute). Lives in its own module
 * because it needs the typebox package, which is only guaranteed resolvable
 * inside pi's extension loading context (see envelope.ts for the pure
 * validation twin used by the main-side settlement and unit tests).
 */
import { Type } from "typebox";

export const EnvelopeSchema = Type.Object(
	{
		status: Type.Union([Type.Literal("done"), Type.Literal("partial"), Type.Literal("blocked")], {
			description: "Product outcome of the RepoOwner's work",
		}),
		summary: Type.String({ description: "One-paragraph outcome summary" }),
		changed_scope: Type.Array(Type.String(), {
			description: "Paths/files/areas actually changed by this run",
		}),
		verification: Type.Array(
			Type.Object({
				check: Type.String({ description: "What was checked (command, test, or manual inspection)" }),
				cwd: Type.Optional(Type.String({ description: "Working directory of the check, when relevant" })),
				result: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("blocked")]),
			}),
			{ description: "Verification evidence: each check with its result" },
		),
		gaps: Type.Array(Type.String(), { description: "What is NOT done or could not be verified" }),
		contract_conflicts: Type.Optional(
			Type.Array(Type.String(), {
				description: "Places where the task contract conflicts with repository reality",
			}),
		),
	},
	{
		additionalProperties: false,
		description:
			"Structured worker report. Required: status, summary, changed_scope, verification, gaps. Optional: contract_conflicts. " +
			"Call report_result exactly once, as your last action; any later tool call invalidates the report.",
	},
);
