/**
 * Custom footer for pi: model · thinking · git · cost · context gauge.
 *
 * Left:  ⏺ model ✻ thinking ▸ branch ▸ $cost
 * Gauge: gradient bar with embedded percentage and context window label
 * Right: used/window tokens
 *
 * Enabled automatically; /footer toggles between it and the default footer.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── ANSI helpers ────────────────────────────────────────────────────────────

const rgb = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
const RESET = "\x1b[0m";
const DIM = (s: string) => `\x1b[2m${s}\x1b[22m`;

/** Lerp between two RGB colors, t in [0,1]. */
function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
	return [
		Math.round(a[0] + (b[0] - a[0]) * t),
		Math.round(a[1] + (b[1] - a[1]) * t),
		Math.round(a[2] + (b[2] - a[2]) * t),
	];
}

// gradient in the omp-footer visual tradition: soft violet → cyan
const GRADIENT: Array<[number, number, number]> = [
	[186, 120, 220],
	[120, 160, 230],
	[100, 200, 220],
];

function gradientColor(t: number): [number, number, number] {
	const clamped = Math.min(0.999, Math.max(0, t));
	const seg = clamped * (GRADIENT.length - 1);
	const i = Math.floor(seg);
	return mix(GRADIENT[i]!, GRADIENT[i + 1]!, seg - i);
}

/** Threshold colors for the percentage label: green → yellow → red. */
function pctColor(pct: number): [number, number, number] {
	if (pct < 50) return [95, 175, 135];
	if (pct < 80) return [220, 180, 90];
	return [225, 110, 110];
}

// ── Formatting ──────────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
	return `${n}`;
}

function fmtWindow(n: number | undefined): string {
	if (!n) return "?";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
	return `${Math.round(n / 1000)}k`;
}

/**
 * Cost display parts: main-session cost plus, when subagents spent money,
 * the grand total (main + all session subagents) shown in parentheses.
 * Threshold mirrors the footer's cost visibility (>= half a cent).
 */
export function costParts(main: number, subagents: number): { main: string | null; grand: string | null } {
	const showMain = main >= 0.005 || subagents >= 0.005;
	return {
		main: showMain ? main.toFixed(2) : null,
		grand: subagents >= 0.005 ? (main + subagents).toFixed(2) : null,
	};
}

interface TurnStats {
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
	/** Context estimate from the most recent assistant message. */
	contextTokens: number;
}

function collectStats(ctx: any): TurnStats {
	let input = 0,
		output = 0,
		cacheRead = 0,
		cost = 0,
		contextTokens = 0;
	const entries = ctx.sessionManager.getBranch() as Array<any>;
	for (const e of entries) {
		if (e.type === "message" && e.message.role === "assistant") {
			const m = e.message as AssistantMessage;
			if (!m.usage) continue;
			input += m.usage.input ?? 0;
			output += m.usage.output ?? 0;
			cacheRead += m.usage.cacheRead ?? 0;
			cost += m.usage.cost?.total ?? 0;
			// Latest assistant message ≈ current context size
			contextTokens = (m.usage.input ?? 0) + (m.usage.cacheRead ?? 0) + (m.usage.cacheWrite ?? 0);
		}
	}
	return { input, output, cacheRead, cost, contextTokens };
}

/** Render the gradient gauge: `───── 20% ─────` filling `width` cells. */
function renderGauge(pct: number, width: number): string {
	if (width < 8) return "";
	const pctLabel = ` ${Math.round(pct)}% `;
	const trackWidth = width - visibleWidth(pctLabel);
	if (trackWidth < 4) return truncateToWidth(pctLabel, width);

	const fill = Math.round((trackWidth * Math.min(100, pct)) / 100);
	const parts: string[] = [];
	// filled part with gradient
	for (let i = 0; i < fill; i++) {
		const [r, g, b] = gradientColor(i / Math.max(1, trackWidth - 1));
		parts.push(`${rgb(r, g, b)}─`);
	}
	// pct label sits at the fill boundary
	parts.push(`${rgb(...pctColor(pct))}${pctLabel}`);
	// remaining track
	const [tr, tg, tb] = mix(GRADIENT[0]!, [70, 70, 80], 0.65);
	parts.push(`${rgb(tr, tg, tb)}${"─".repeat(Math.max(0, trackWidth - fill))}`);
	parts.push(RESET);
	return truncateToWidth(parts.join(""), width);
}

export default function (pi: ExtensionAPI) {
	let active = false; // footer currently installed
	let userDisabled = false; // user explicitly turned it off
	let activeTui: any;
	/** Latest subagent cost total for this session (live runtime + persisted results). */
	let subagentCost = 0;

	// The subagents extension owns the number and emits the full total on
	// every change (session_start persisted sum, live per-child stats). We
	// only cache and repaint. Pre-startup events (emitted before this
	// extension loads) are covered by the session_start emission.
	pi.events?.on?.("subagents:cost", (data: unknown) => {
		const total = (data as { total?: unknown } | null)?.total;
		if (typeof total === "number" && Number.isFinite(total) && total !== subagentCost) {
			subagentCost = total;
			if (active) activeTui?.requestRender();
		}
	});

	function installFooter(ctx: any) {
		active = true;
		ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
			activeTui = tui;
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const stats = collectStats(ctx);
					const window = (ctx.model as any)?.contextWindow as number | undefined;
					const pct = window ? (stats.contextTokens / window) * 100 : 0;

					// ── left group (nerd font glyphs) ──
					const ICON = {
						chip: "\uf2db", // nf-fa-microchip — model
						folder: "\uf07b", // nf-fa-folder — cwd
						branch: "\ue725", // nf-dev-git_branch
					};
					// omp-style thinking glyphs (plain unicode, no nerd font needed)
					const THINKING: Record<string, string> = {
						minimal: "○",
						low: "◔",
						medium: "◑",
						high: "◒",
						xhigh: "◕",
						max: "◉",
					};
					const dot = stats.cost > 0 ? theme.fg("success", "⏺") : theme.fg("muted", "⏺");
					const model = theme.fg("accent", `${ICON.chip} ${(ctx.model?.id ?? "no model").split("/").pop() ?? "?"}`);
					const thinkGlyph = THINKING[String(ctx.thinkingLevel)] ?? "◈";
					const think =
						ctx.thinkingLevel && ctx.thinkingLevel !== "off"
							? DIM(` ${thinkGlyph} ${ctx.thinkingLevel}`)
							: "";
					// path: home → ~, keep last 2 segments
					const home = (process.env.HOME ?? "").replace(/\/$/, "");
					const rawPath = (ctx.cwd ?? process.cwd()).replace(new RegExp(`^${home}`), "~");
					const segs = rawPath.split("/").filter(Boolean);
					const shortPath = rawPath.startsWith("~") && segs.length > 2 ? `~/${segs.slice(-2).join("/")}` : rawPath;
					const pathPart = theme.fg("muted", `${ICON.folder} ${shortPath}`);
					const branch = footerData.getGitBranch();
					const git = branch ? theme.fg("muted", `${ICON.branch} ${branch}`) : "";
					const costs = costParts(stats.cost, subagentCost);
					const cost = costs.main
						? theme.fg(
								"warning",
								`$${costs.main}${costs.grand ? DIM(` ($${costs.grand})`) : ""}`,
						  )
						: "";
					const sep = DIM(" ▸ ");
					const left = [dot, model + think, pathPart, git, cost].filter(Boolean).join(sep);

					// ── gauge + right: colored window size (actual is clear from the bar) ──
					const [pr, pg, pb] = pctColor(pct);
					const right = `${rgb(pr, pg, pb)}${fmtWindow(window)}${RESET}`;

					const leftW = visibleWidth(left);
					const rightW = visibleWidth(right);
					const gaugeWidth = width - leftW - rightW - 2;
					const gauge = renderGauge(pct, Math.max(0, gaugeWidth));

					const line = gauge
						? `${left} ${gauge}${right}`
						: `${left}${" ".repeat(Math.max(1, width - leftW - rightW))}${right}`;
					return [truncateToWidth(line, width)];
				},
			};
		});
	}

	// Re-install on every session start (session switches rebuild the UI)
	pi.on("session_start", async (_event, ctx) => {
		if (!userDisabled) installFooter(ctx);
	});

	pi.registerCommand("footer", {
		description: "Toggle the custom footer",
		handler: async (_args, ctx) => {
			if (!active) {
				userDisabled = false;
				installFooter(ctx);
				ctx.ui.notify("custom footer enabled", "info");
			} else {
				userDisabled = true;
				active = false;
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("default footer restored", "info");
			}
		},
	});

	// Repaint when new messages land so cost/context stay fresh
	pi.on("message_end", async () => {
		if (active) activeTui?.requestRender();
	});
}
