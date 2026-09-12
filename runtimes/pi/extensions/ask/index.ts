/**
 * ask — the canonical model-facing question tool for interactive Main
 * sessions (extensions/ask). One tool, one contract (contract.ts), three
 * delivery backends chosen at execute time:
 *
 * - TUI mode: the rich custom dialog (dialog.ts) as an overlay;
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
					const meta = [q.multi ? "multi" : undefined, `${q.options.length} options`]
						.filter(Boolean)
						.join(" · ");
					container.addChild(
						new Text(
							` ${theme.fg("accent", theme.bold("Ask"))} ${theme.fg("muted", `[${q.id}]${meta}`)}`,
							1,
							0,
						),
					);
					container.addChild(new Text(` ${theme.fg("toolOutput", q.question)}`, 1, 0));
					for (const option of q.options) {
						const mark = theme.fg("muted", option.multi ? "☐" : "○");
						container.addChild(
							new Text(`   ${mark} ${theme.fg("toolOutput", option.label)}`, 1, 0),
						);
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
			done(undefined);
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
	}, {
		overlay: true,
		overlayOptions: { width: "70%", minWidth: 52, maxHeight: "80%", anchor: "center" },
	});
	if (result === undefined) {
		// Dismissed because the run was aborted — the caller (pi) discards this
		// tool call anyway; report cancelled so nothing pretends an answer.
		return { kind: "cancelled" };
	}
	return result;
}

// ================================================================= helpers

interface RenderQuestion {
	id: string;
	question: string;
	multi?: boolean;
	options: Array<{ label: string; multi?: boolean }>;
}

function normalizeQuestions(raw: unknown): RenderQuestion[] {
	if (!Array.isArray(raw)) return [];
	const out: RenderQuestion[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const q = entry as Record<string, unknown>;
		if (typeof q.id !== "string" || typeof q.question !== "string") continue;
		const options: Array<{ label: string; multi?: boolean }> = [];
		if (Array.isArray(q.options)) {
			for (const option of q.options) {
				if (option && typeof option === "object" && typeof (option as { label?: unknown }).label === "string") {
					options.push({ label: (option as { label: string }).label });
				}
			}
		}
		out.push({
			id: q.id,
			question: q.question,
			...(q.multi === true ? { multi: true } : {}),
			options,
		});
	}
	return out;
}
