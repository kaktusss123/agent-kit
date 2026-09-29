/**
 * ask — the canonical model-facing question tool for interactive Main
 * sessions (extensions/ask). One tool, one contract (contract.ts), three
 * delivery backends chosen at execute time:
 *
 * - TUI mode: the rich custom dialog (dialog.ts) replacing the editor surface;
 * - RPC mode (no custom UI surface): per-question select/input fallback;
 * - no interactive UI (print/json/headless): fail closed — an explicit
 *   unavailable error, never a pretended answer (SPEC A12).
 *
 * Subagent children get the same `ask` from the subagents bridge; they never
 * load this extension (children run with --no-extensions -e bridge.ts).
 */
import { type ExtensionAPI, DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { AskInput, AskOutcome } from "./contract";
import { AskDialog, type AskDialogResult } from "./dialog";
import { buildAskTool, rpcFallbackAsk, type AskBackend } from "./tool";

export default function (pi: ExtensionAPI) {
	const backend: AskBackend = async (questions, signal, rawCtx) => {
		const ctx = rawCtx as AskToolCtx | undefined;
		if (!ctx || !ctx.hasUI || !ctx.ui) {
			return {
				unavailable:
					"ask requires an interactive UI and this environment has none (headless session); " +
					"the question was NOT shown to anyone",
			};
		}
		if (ctx.mode === "tui") {
			return await richDialogAsk(ctx, questions, signal);
		}
		// RPC and other dialog-capable modes: standard pi extension UI dialogs.
		return await rpcFallbackAsk(
			{
				select: (title, options, opts) => ctx.ui.select(title, options, opts),
				input: (title, placeholder, opts) => ctx.ui.input(title, placeholder, opts),
			},
			questions.questions,
			signal,
		);
	};

	pi.registerTool({
		...buildAskTool(backend),
		// Rich transcript rendering for the call and the answer.
		renderCall(args, theme) {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("borderMuted", s)));
			const questions = normalizeQuestions(args?.questions);
			if (questions.length === 0) {
				container.addChild(new Text(theme.fg("warning", " ask — no questions"), 1, 0));
			} else {
				for (const q of questions) {
					const meta = ` [${q.id}${q.header ? " · " + q.header : ""}${q.multi ? " · multi" : ""} · ${q.options.length} options]`;
					container.addChild(
						new Text(
							` ${theme.fg("accent", theme.bold("Ask"))} ${theme.fg("muted", meta)}`,
							1,
							0,
						),
					);
					container.addChild(new Text(` ${theme.fg("toolOutput", q.question)}`, 1, 0));
					for (const [index, option] of q.options.entries()) {
						const mark = theme.fg("muted", q.multi ? "☐" : "○");
						const recommended =
							q.recommended === index ? theme.fg("muted", " · recommended") : "";
						container.addChild(
							new Text(`   ${mark} ${theme.fg("toolOutput", option.label)}${recommended}`, 1, 0),
						);
						if (option.description) {
							container.addChild(
								new Text(`     ${theme.fg("muted", option.description)}`, 1, 0),
							);
						}
					}
					if (q !== questions[questions.length - 1]) container.addChild(new Text("", 1, 0));
				}
			}
			container.addChild(new DynamicBorder((s: string) => theme.fg("borderMuted", s)));
			return container;
		},
		renderResult(result, options, theme) {
			const details = (result.details ?? {}) as Record<string, unknown>;
			const expanded = options?.expanded ?? false;
			const text = result.content
				.map((c) => (c.type === "text" ? c.text : ""))
				.filter(Boolean)
				.join("\n");
			const failed = typeof details.error === "string";
			const icon = failed
				? theme.fg("error", "✗")
				: details.chatRedirect || details.cancelled
					? theme.fg("warning", "!")
					: theme.fg("success", "✓");
			const lines = [` ${icon} ${theme.fg("accent", theme.bold("Ask"))}`];
			for (const line of text.split("\n")) lines.push(`   ${theme.fg("toolOutput", line)}`);
			if (expanded && Array.isArray(details.results)) {
				for (const r of details.results as Array<{ id?: string }>) {
					lines.push(`   ${theme.fg("dim", `[${r.id ?? "??"}]`)}`);
				}
			}
			const container = new Container();
			for (const line of lines) container.addChild(new Text(line, 0, 0));
			return container;
		},
	});
}

// ============================================================== dialog path

interface AskToolCtx {
	mode: "tui" | "rpc" | "json" | "print";
	hasUI: boolean;
	ui: {
		custom<T>(
			factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (r: AskDialogResult) => void) => unknown,
			options?: Record<string, unknown>,
		): Promise<T | undefined>;
		select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
		input(
			title: string,
			placeholder: string | undefined,
			opts?: { signal?: AbortSignal },
		): Promise<string | undefined>;
	};
}

async function richDialogAsk(
	ctx: AskToolCtx,
	questions: AskInput,
	signal: AbortSignal | undefined,
): Promise<AskOutcome | { unavailable: string }> {
	// Typed through the structural AskToolCtx.ui above; the real ExtensionUIContext
	// satisfies this shape (methods are compatible at runtime).
	const ui = ctx.ui as unknown as {
		custom<T>(
			factory: (tui: never, theme: never, keybindings: never, done: (r: AskDialogResult) => void) => unknown,
			options?: {
				overlay?: boolean;
				overlayOptions?: Record<string, unknown>;
			},
		): Promise<T | undefined>;
	};
	const result = await ui.custom<AskDialogResult>((tui, theme, _keybindings, done) => {
		const dialog = new AskDialog(questions.questions, theme, done);
		dialog.tuiRef = tui;
		const onAbort = () => {
			// Explicit interrupt only (Esc never aborts): answered questions
			// survive in partialResults so the transcript renders them.
			done(dialog.cancelledOutcome());
			signal?.removeEventListener("abort", onAbort);
		};
		if (signal) {
			if (signal.aborted) done(undefined);
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		return {
			render: (width: number) => dialog.render(width),
			handleInput: (data: string) => dialog.handleInput(data),
			invalidate: () => dialog.invalidate(),
			get focused() {
				return dialog.focused;
			},
			set focused(value: boolean) {
				dialog.focused = value;
			},
		} as never;
	});
	if (result === undefined) {
		// The custom surface was dismissed without an outcome — report
		// cancelled so nothing pretends an answer.
		return { kind: "cancelled" };
	}
	return result;
}

// ================================================================= helpers

interface RenderQuestion {
	id: string;
	question: string;
	header?: string;
	multi?: boolean;
	recommended?: number;
	options: Array<{ label: string; description?: string }>;
}

function normalizeQuestions(raw: unknown): RenderQuestion[] {
	if (!Array.isArray(raw)) return [];
	const out: RenderQuestion[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const q = entry as Record<string, unknown>;
		if (typeof q.id !== "string" || typeof q.question !== "string") continue;
		const options: Array<{ label: string; description?: string }> = [];
		if (Array.isArray(q.options)) {
			for (const option of q.options) {
				if (option && typeof option === "object" && typeof (option as { label?: unknown }).label === "string") {
					options.push({
						label: (option as { label: string }).label,
						...(typeof (option as { description?: unknown }).description === "string"
							? { description: (option as { description: string }).description }
							: {}),
					});
				}
			}
		}
		out.push({
			id: q.id,
			question: q.question,
			...(typeof q.header === "string" ? { header: q.header } : {}),
			...(q.multi === true ? { multi: true } : {}),
			...(typeof q.recommended === "number" ? { recommended: q.recommended } : {}),
			options,
		});
	}
	return out;
}
