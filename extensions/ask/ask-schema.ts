/**
 * TypeBox schema for the canonical `ask` tool — the machine-checkable twin of
 * contract.ts. Both the Main-side registration (extensions/ask/index.ts) and
 * the subagent child bridge pass this exact schema to pi.registerTool, so pi
 * validates model arguments against one shared definition everywhere.
 *
 * Lives in its own module because it needs the typebox package, which is only
 * guaranteed resolvable inside pi's extension loading context.
 */
import { Type } from "typebox";
import { ASK_TOOL_DESCRIPTION } from "./contract";

export const AskOptionSchema = Type.Object({
	label: Type.String({ description: "Short display label for the option" }),
	description: Type.Optional(
		Type.String({ description: "One-line explanation of the option or its tradeoff" }),
	),
	preview: Type.Optional(
		Type.String({ description: "Optional longer markdown/code preview shown for this option" }),
	),
}, {
	additionalProperties: false,
	description:
		"One selectable option: label plus optional description and preview. No other fields — a recommendation belongs on the question, not here.",
});

export const AskQuestionSchema = Type.Object({
	id: Type.String({ description: "Stable identifier for this question, used in the result" }),
	question: Type.String({ description: "The question text shown to the answerer" }),
	header: Type.Optional(
		Type.String({ description: "Optional short display chip used by multi-question UIs" }),
	),
	options: Type.Array(AskOptionSchema, {
		description: "Available options (the runtime adds a free-form response action automatically)",
	}),
	multi: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options" })),
	recommended: Type.Optional(
		Type.Number({
			description:
				"Zero-based index of the recommended option. A UI hint only — set it here on the question, never inside individual options.",
		}),
	),
}, { additionalProperties: false });

export const AskSchema = Type.Object({
	questions: Type.Array(AskQuestionSchema, {
		description: "Related questions to ask in one interaction; group when practical",
		minItems: 1,
	}),
}, {
	additionalProperties: false,
	description: ASK_TOOL_DESCRIPTION,
});
