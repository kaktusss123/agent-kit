/**
 * session-title — name the session from its first user message.
 *
 * On the first prompt of a TUI session, asks a cheap model for a concise task
 * title and sets it via pi.setSessionName(). In TUI mode the extension also
 * owns the terminal title: it paints the bare session name (no "π - <name> -
 * <cwd>" composition), so Warp/iTerm tabs show exactly what the session is
 * about. Clearing the name restores pi's default composed title.
 *
 * Best-effort by contract: failures (no auth, model errors, timeouts) are
 * silent, the run is never delayed — generation happens off the turn path —
 * and a manually set name (via /name or pi.setSessionName) always wins:
 * it is re-checked immediately before writing.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildTitlePrompt,
	modelClassesFile,
	readCheapModelClass,
	sanitizeTitle,
	TITLE_SYSTEM_PROMPT,
} from "./title";

/** One attempt per session: no retry loop, no re-naming on later messages. */
const TITLE_TIMEOUT_MS = 20_000;
const TITLE_MAX_TOKENS = 300;

export default function sessionTitleExtension(pi: ExtensionAPI): void {
	let attempted = false;
	// Single pending re-assert handle: a newer event supersedes the old timer.
	let titleTimer: NodeJS.Timeout | undefined;

	pi.on("session_start", (_event, ctx) => {
		// /new, /resume, /fork rebind the session — the next first prompt names it.
		attempted = false;
		// After /resume or /fork of a named session, pi init has already painted
		// its composed title and no session_info_changed fires — override now.
		const name = pi.getSessionName();
		if (ctx.mode === "tui" && name) ctx.ui.setTitle(name);
	});

	pi.on("session_info_changed", (_event, ctx) => {
		// A newer event supersedes any pending re-assert: drop it, reschedule.
		if (titleTimer) clearTimeout(titleTimer);
		const name = pi.getSessionName();
		if (ctx.mode !== "tui" || !name) return; // Cleared: leave pi's default title.
		ctx.ui.setTitle(name);
		// pi's own handler recomposes the three-part title from this same event
		// and relative handler order is not guaranteed — re-assert once on a
		// macrotask so the bare name deterministically wins. The name is re-read
		// at fire time: clearing or renaming while the macrotask is pending must
		// not repaint the stale captured value.
		titleTimer = setTimeout(() => {
			titleTimer = undefined;
			const fresh = pi.getSessionName();
			if (fresh) ctx.ui.setTitle(fresh);
		}, 0);
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (attempted) return;
		if (ctx.mode !== "tui") return;
		const prompt = event.prompt.trim();
		if (!prompt) return;
		attempted = true;
		if (pi.getSessionName()) return; // Respect a name set before the first prompt.

		// Off the turn path: the handler returns immediately; the title lands
		// whenever the model answers (or never, on failure).
		void generateTitle(prompt, ctx, pi).catch(() => {});
	});
}

/** Saved "cheap" class if resolvable and authenticated, else the active session model. */
function pickTitleModel(ctx: ExtensionContext): ExtensionContext["model"] {
	try {
		const saved = readCheapModelClass(modelClassesFile());
		if (saved) {
			const slash = saved.indexOf("/");
			const model = ctx.modelRegistry.find(saved.slice(0, slash), saved.slice(slash + 1));
			if (model && ctx.modelRegistry.hasConfiguredAuth(model)) return model;
		}
	} catch {
		// Fall through to the active model.
	}
	return ctx.model ?? undefined;
}

async function generateTitle(prompt: string, ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	const model = pickTitleModel(ctx);
	if (!model) return;

	const response = await ctx.modelRegistry.complete(
		model,
		{
			systemPrompt: TITLE_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: buildTitlePrompt(prompt) }],
					timestamp: Date.now(),
				},
			],
		},
		{ signal: AbortSignal.timeout(TITLE_TIMEOUT_MS), maxTokens: TITLE_MAX_TOKENS, cacheRetention: "none" },
	);
	if (response.stopReason === "aborted" || response.stopReason === "error") return;

	const text = response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	const title = sanitizeTitle(text);
	// Re-check: the user may have named the session while the model was answering.
	if (title && !pi.getSessionName()) pi.setSessionName(title);
}
