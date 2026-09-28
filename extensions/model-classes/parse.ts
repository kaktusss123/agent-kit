/**
 * Parsing for the `/model-class` command line.
 *
 * The whole CLI contract lives here:
 *
 *   /model-class                                  → status
 *   /model-class <class>                          → switch the session to the saved pair
 *   /model-class <class> set                      → save the current pair into the class
 *   /model-class <class> unset                    → delete the saved class
 *   /model-class next                             → cycle to the next saved class
 *   /model-class route                            → show the routing table
 *   /model-class route <plain|repoOwner> <class|inherit>
 *                                                 → set/reset a spawn mode's default
 *
 * The parser is purely syntactic: class-name grammar and reserved words are
 * checked here, but whether a name is actually SAVED is runtime state —
 * resolution fails closed with the saved names listed. Invalid input yields
 * `{ kind: "invalid" }` with a reason; the caller appends the short usage.
 *
 * Pure module: no pi imports.
 */
import {
	isClassName,
	RESERVED_CLASS_WORDS,
	SPAWN_MODES,
	type ModelClassName,
	type RouteTarget,
	type SpawnMode,
} from "./store";

export type ParsedModelClassCommand =
	| { kind: "status" }
	| { kind: "switch"; name: ModelClassName }
	| { kind: "set"; name: ModelClassName }
	| { kind: "unset"; name: ModelClassName }
	| { kind: "next" }
	| { kind: "routeStatus" }
	| { kind: "routeSet"; mode: SpawnMode; target: RouteTarget }
	| { kind: "invalid"; reason: string };

export const MODEL_CLASS_USAGE = [
	"Usage:",
	"  /model-class",
	"  /model-class <class>",
	"  /model-class <class> set",
	"  /model-class <class> unset",
	"  /model-class next",
	"  /model-class route",
	"  /model-class route <plain|repoOwner> <class|inherit>",
].join("\n");

export const MODEL_CLASS_DEFAULT_HINT =
	"default is not a stored class: it always mirrors the current model + thinking.";

function isSpawnMode(token: string): token is SpawnMode {
	return (SPAWN_MODES as readonly string[]).includes(token);
}

/** Why `token` cannot be a class name (reserved word or grammar). */
function nameError(token: string): string {
	if (token === "default") return MODEL_CLASS_DEFAULT_HINT;
	if ((RESERVED_CLASS_WORDS as readonly string[]).includes(token)) {
		return `"${token}" is a reserved word and cannot be a class name.`;
	}
	return (
		`Invalid class name: "${token}". ` +
		`Class names are 1-32 chars: a lowercase letter, then lowercase letters, digits, or dashes.`
	);
}

export function parseModelClassCommand(args: string | undefined): ParsedModelClassCommand {
	const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { kind: "status" };
	const [first, second, third] = tokens;

	if (first === "next" && tokens.length === 1) return { kind: "next" };
	if (first === "route") return parseRoute(tokens);
	if (tokens.length === 1) {
		if (isClassName(first!)) return { kind: "switch", name: first };
		return { kind: "invalid", reason: nameError(first!) };
	}
	if (tokens.length === 2 && (second === "set" || second === "unset")) {
		if (isClassName(first!)) return { kind: second, name: first };
		return { kind: "invalid", reason: nameError(first!) };
	}
	return { kind: "invalid", reason: `Unexpected arguments: ${tokens.map((t) => `"${t}"`).join(" ")}.` };
}

function parseRoute(tokens: string[]): ParsedModelClassCommand {
	const [, mode, target] = tokens;
	if (tokens.length === 1) return { kind: "routeStatus" };
	if (tokens.length === 2) {
		return {
			kind: "invalid",
			reason: `Routing a mode needs a target: \`/model-class route <plain|repoOwner> <class|inherit>\`.`,
		};
	}
	if (tokens.length > 3) {
		return { kind: "invalid", reason: `Unexpected arguments: ${tokens.map((t) => `"${t}"`).join(" ")}.` };
	}
	if (!isSpawnMode(mode!)) {
		return { kind: "invalid", reason: `Unknown spawn mode: "${mode}". Modes: plain, repoOwner.` };
	}
	if (target === "inherit") return { kind: "routeSet", mode, target: "inherit" };
	if (target === "default") {
		return {
			kind: "invalid",
			reason: `"default" is not routable: use \`inherit\` to route a mode to the session pair.`,
		};
	}
	if (isClassName(target!)) return { kind: "routeSet", mode, target };
	return { kind: "invalid", reason: `Invalid routing target: "${target}". Use a saved class name or \`inherit\`.` };
}
