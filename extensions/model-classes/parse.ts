/**
 * Parsing for the `/model-class` command line.
 *
 * The whole CLI contract lives here:
 *
 *   /model-class                     → status
 *   /model-class <cheap|smart>       → switch the session to the saved pair
 *   /model-class <cheap|smart> set   → save the current pair into the class
 *
 * Nothing else exists: `default` is not addressable (it is always the
 * current session state), there is no help/edit/reset. Invalid input yields
 * `{ kind: "invalid" }` with a reason; the caller appends the short usage.
 *
 * Pure module: no pi imports.
 */
import type { ModelClassName } from "./store";

export type ParsedModelClassCommand =
	| { kind: "status" }
	| { kind: "switch"; name: ModelClassName }
	| { kind: "set"; name: ModelClassName }
	| { kind: "invalid"; reason: string };

export const MODEL_CLASS_USAGE = [
	"Usage:",
	"  /model-class",
	"  /model-class <cheap|smart>",
	"  /model-class <cheap|smart> set",
].join("\n");

export const MODEL_CLASS_DEFAULT_HINT =
	"default is not a stored class: it always mirrors the current model + thinking.";

function isClassName(token: string): token is ModelClassName {
	return token === "cheap" || token === "smart";
}

export function parseModelClassCommand(args: string | undefined): ParsedModelClassCommand {
	const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { kind: "status" };
	if (tokens.length === 1) {
		const [name] = tokens;
		if (isClassName(name)) return { kind: "switch", name };
		if (name === "default") return { kind: "invalid", reason: MODEL_CLASS_DEFAULT_HINT };
		return { kind: "invalid", reason: `Unknown model class: "${name}".` };
	}
	if (tokens.length === 2 && tokens[1] === "set") {
		const [name] = tokens;
		if (isClassName(name)) return { kind: "set", name };
		if (name === "default") return { kind: "invalid", reason: MODEL_CLASS_DEFAULT_HINT };
		return { kind: "invalid", reason: `Unknown model class: "${name}".` };
	}
	return { kind: "invalid", reason: `Unexpected arguments: ${tokens.map((t) => `"${t}"`).join(" ")}.` };
}
