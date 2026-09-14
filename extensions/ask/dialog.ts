/**
 * Rich TUI ask dialog for interactive Main sessions, built on pi-tui
 * primitives (SelectList/Input/Markdown) — the pi port of the OMP ask-dialog
 * workflow: per-question lists, arrow navigation with preserved answers,
 * single/multi-select, recommended hints, descriptions, previews, free-form
 * response input, a review screen, and "Chat about this".
 *
 * This module is presentation only: all behavior lives in core.ts, and the
 * tool wiring lives in tool.ts. Not unit-tested (needs a terminal); the
 * shared behavior it drives is.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Input,
	Key,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	type SelectItem,
	SelectList,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AskOutcome, AskQuestion } from "./contract";
import {
	activateRow,
	advance,
	clampCursor,
	currentQuestion,
	type DialogState,
	descriptionFor,
	goBack,
	initialState,
	previewFor,
	reviewLines,
	rowsFor,
	submitOther,
	submitReview,
} from "./core";

export type AskDialogResult = AskOutcome | undefined;

/** Injectable markdown theme: production reads pi's initialized theme. */
export interface AskDialogOptions {
	markdownTheme?: () => MarkdownTheme;
}

export class AskDialog implements Component {
	private readonly questions: AskQuestion[];
	private readonly theme: Theme;
	private readonly done: (result: AskDialogResult) => void;
	private readonly state: DialogState;

	private selectList: SelectList;
	private readonly input: Input;
	private questionMd?: Markdown;
	private previewMd?: Markdown;
	private previewText?: string;
	private readonly markdownTheme?: () => MarkdownTheme;
	/** Injected by the wiring so key handling can trigger re-renders. */
	tuiRef?: TUI;
	/** Focusable passthrough so the hardware cursor lands on the Input row. */
	focused = false;

	constructor(
		questions: AskQuestion[],
		theme: Theme,
		done: (result: AskDialogResult) => void,
		options?: AskDialogOptions,
	) {
		this.questions = questions;
		this.theme = theme;
		this.done = done;
		this.markdownTheme = options?.markdownTheme;
		this.state = initialState(questions);
		this.selectList = new SelectList([], 10, {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		});
		this.syncSelectList();
		this.input = new Input({ prompt: "> " });
		this.input.onSubmit = (value) => {
			submitOther(this.state, this.questions, value);
			this.afterMutation();
		};
		this.input.onEscape = () => {
			this.state.mode = "question";
			this.afterMutation();
		};
	}

	// ------------------------------------------------------------- internals

	private syncSelectList(): void {
		const rows = rowsFor(this.state, this.questions);
		const theme = this.theme;
		const list = new SelectList(
			rows.map((row, i) => ({
				value: String(i),
				label: row.label,
				...(row.description ? { description: row.description } : {}),
			})),
			10,
			{
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
			// Widen the label column so recommended labels survive uncapped at 32.
			{ minPrimaryColumnWidth: 20, maxPrimaryColumnWidth: 48 },
		);
		list.onSelect = (item) => this.onRowActivated(item);
		list.setSelectedIndex(Math.min(this.state.cursor, Math.max(0, rows.length - 1)));
		this.selectList = list;
	}

	private onRowActivated(item: SelectItem): void {
		this.state.cursor = Number(item.value);
		const wasQuestionMode = this.state.mode === "question";
		activateRow(this.state, this.questions);
		if (wasQuestionMode && this.state.mode === "other") this.input.setValue("");
		this.afterMutation();
	}

	/** Called after any state mutation: resolve or keep the dialog alive. */
	private afterMutation(): void {
		if (this.state.outcome) {
			this.done(this.state.outcome);
			return;
		}
		this.syncSelectList();
		this.tuiRef?.requestRender();
	}

	// ----------------------------------------------------------- input handling

	handleInput(data: string): void {
		if (this.state.outcome) return;
		if (this.state.mode === "other") {
			this.input.handleInput(data);
			this.tuiRef?.requestRender();
			return;
		}
		if (this.state.mode === "review") {
			if (matchesKey(data, Key.enter)) {
				submitReview(this.state, this.questions);
				this.afterMutation();
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
				goBack(this.state, this.questions);
				this.afterMutation();
				return;
			}
			return;
		}
		// Question mode.
		if (matchesKey(data, Key.escape)) {
			this.state.outcome = { kind: "cancelled" };
			this.done(this.state.outcome);
			return;
		}
		if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
			advance(this.state, this.questions);
			this.afterMutation();
			return;
		}
		if (matchesKey(data, Key.left)) {
			goBack(this.state, this.questions);
			this.afterMutation();
			return;
		}
		this.selectList.handleInput(data);
		// Track the SelectList cursor for the preview pane.
		const selected = this.selectList.getSelectedItem();
		if (selected) this.state.cursor = Number(selected.value);
		clampCursor(this.state, this.questions);
		this.tuiRef?.requestRender();
	}

	// ------------------------------------------------------------- rendering

	render(width: number): string[] {
		// Keep the Input's focus flag in sync for IME cursor positioning.
		this.input.focused = this.focused && this.state.mode === "other";
		const lines: string[] = [];
		const q = currentQuestion(this.state, this.questions);
		const n = this.questions.length;
		const header = this.headerLine(width, n);
		if (header) lines.push(header);

		if (this.state.mode === "review") {
			lines.push(...wrapTextWithAnsi(this.theme.fg("toolOutput", this.theme.bold("Review your answers")), width));
			for (const line of reviewLines(this.state, this.questions)) {
				lines.push(truncateToWidth(` ${this.theme.fg("muted", line)}`, width));
			}
			lines.push("");
			lines.push(this.helpLine(width, "enter submit · esc back to questions"));
			return lines;
		}
		if (!q) return lines;

		if (this.state.mode === "other") {
			lines.push(...this.questionLines(width, q.question));
			lines.push("");
			lines.push(...this.input.render(width));
			lines.push("");
			lines.push(this.helpLine(width, "enter submit · esc back"));
			return lines;
		}

		lines.push(...this.questionLines(width, q.question));
		lines.push("");
		lines.push(...this.selectList.render(width));
		const description = descriptionFor(this.state, this.questions);
		if (description && description.trim().length > 0) {
			lines.push("");
			lines.push(...this.descriptionLines(width, description));
		}
		const preview = previewFor(this.state, this.questions);
		if (preview && preview.trim().length > 0) {
			lines.push("");
			lines.push(...this.previewLines(width, preview));
		}
		lines.push("");
		lines.push(this.helpLine(width, "↑↓ navigate · enter select · ←/→ question · esc cancel"));
		return lines;
	}

	private headerLine(width: number, n: number): string {
		const q = currentQuestion(this.state, this.questions);
		const title = this.theme.fg("accent", this.theme.bold("Ask"));
		if (this.state.mode === "review" || !q) {
			return truncateToWidth(`${title} ${this.theme.fg("muted", "review")}`, width);
		}
		const pos = n > 1 ? `${this.state.index + 1}/${n} ` : "";
		const chip = q.header?.trim() ? ` · ${q.header.trim()}` : "";
		const meta = this.theme.fg("muted", `${pos}[${q.id}]${chip}`);
		return truncateToWidth(`${title} ${meta}`, width);
	}

	private questionLines(width: number, question: string): string[] {
		if (!this.questionMd) {
			this.questionMd = new Markdown(question, 1, 0, this.mdTheme());
		} else {
			this.questionMd.setText(question);
		}
		return this.questionMd.render(Math.max(8, width - 2));
	}

	private mdTheme(): MarkdownTheme {
		return this.markdownTheme ? this.markdownTheme() : getMarkdownTheme();
	}

	private previewLines(width: number, preview: string): string[] {
		if (!this.previewMd || this.previewText !== preview) {
			this.previewMd = new Markdown(preview, 0, 0, this.mdTheme());
			this.previewText = preview;
		}
		const inner = Math.max(8, width - 6);
		return this.previewMd
			.render(inner)
			.map((line) => truncateToWidth(`   ${this.theme.fg("border", "│")} ${line}`, width));
	}

	private descriptionLines(width: number, description: string): string[] {
		const inner = Math.max(8, width - 6);
		return wrapTextWithAnsi(description, inner).map((line) =>
			truncateToWidth(`   ${this.theme.fg("muted", line)}`, width),
		);
	}

	private helpLine(width: number, help: string): string {
		return truncateToWidth(this.theme.fg("dim", ` ${help}`), width);
	}

	invalidate(): void {
		this.questionMd = undefined;
		this.previewMd = undefined;
		this.previewText = undefined;
	}
}
