/**
 * proxy-toggle — machine-level proxy preference for the Pi agent environment.
 *
 * One persisted preference (proxy-state.json, see ./proxy-lib.ts), applied to
 * every pi process that loads proxy machinery:
 *
 *   /proxy on|off
 *     ↓ persist preference (proxy-state.json)
 *     ↓ apply to this Main process (undici global dispatcher, no restart)
 *     ↓ notify existing subagent children ("proxy-changed" bus channel →
 *       subagents runtime pushes /proxy on|off over the existing RPC link)
 *     ↓ future processes (new Main, new subagents) apply the same preference
 *       at session_start and self-heal on before_agent_start
 *
 * Bash children never inherit proxy env: corp-internal hosts must stay
 * direct. NO_PROXY hosts bypass the proxy even when ON (EnvHttpProxyAgent).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	applyProxyPreference,
	dispatcherMatchesPreference,
	readProxyState,
	reapplyIfDrifted,
	writeProxyState,
} from "./proxy/proxy-lib.ts";

interface PushResult {
	enabled?: boolean;
	acked?: number;
	total?: number;
	error?: string;
}

export default function (pi: ExtensionAPI) {
	let lastPush: PushResult | null = null;

	const reflectStatus = (ctx: { ui?: { setStatus?(key: string, text?: string): void } }) => {
		const state = readProxyState();
		ctx.ui?.setStatus?.("proxy", state.enabled ? `proxy: on` : undefined);
	};

	// session_start runs after pi's startup dispatcher installs in every mode
	// (interactive, print, rpc), so the persisted preference wins at startup.
	pi.on("session_start", async (_event, ctx) => {
		await applyProxyPreference();
		reflectStatus(ctx as { ui?: { setStatus?(key: string, text?: string): void } });
	});

	// Clobber-proofing + self-healing: right before each model request the
	// dispatcher is forced to match the persisted preference, whatever pi
	// reinstalled in between (reload, settings rebind) and regardless of a
	// missed live push.
	pi.on("before_agent_start", async () => {
		await reapplyIfDrifted();
	});

	// Live subagent children report their push outcome here.
	pi.events.on("proxy-push-result", (data) => {
		lastPush = (data ?? {}) as PushResult;
	});

	const pushToLiveChildren = (enabled: boolean): Promise<PushResult | null> =>
		new Promise((resolve) => {
			const off = pi.events.on("proxy-push-result", (data) => {
				clearTimeout(timer);
				off();
				resolve((data ?? {}) as PushResult);
			});
			const timer = setTimeout(() => {
				off();
				resolve(null);
			}, 3000);
			timer.unref?.();
			pi.events.emit("proxy-changed", { enabled });
		});

	const describeMain = (enabled: boolean): string =>
		dispatcherMatchesPreference(enabled) ? "main active" : "main pending (applies at next request)";

	pi.registerCommand("proxy", {
		description: "Toggle corporate proxy (/proxy on|off|status)",
		handler: async (args: string, ctx: unknown) => {
			const ui = (ctx as { ui?: { notify?(message: string, type?: string): void } }).ui;
			const arg = args?.trim().toLowerCase();
			const current = readProxyState();

			if (arg === "status" || arg === "") {
				const push =
					lastPush && lastPush.enabled === current.enabled
						? `\nsubagents: last push ${lastPush.acked}/${lastPush.total}${lastPush.error ? ` (${lastPush.error})` : ""}`
						: "";
				ui?.notify?.(
					`proxy: ${current.enabled ? "on" : "off"} · ${current.url} · ${describeMain(current.enabled)}${push}`,
					"info",
				);
				return;
			}
			if (arg !== "on" && arg !== "off") {
				ui?.notify?.("Usage: /proxy on|off|status", "warning");
				return;
			}

			const enabled = arg === "on";
			const state = readProxyState();
			writeProxyState({ enabled, url: state.url });
			await applyProxyPreference();
			reflectStatus(ctx as { ui?: { setStatus?(key: string, text?: string): void } });

			// The preference is persisted and active in Main at this point.
			// Push outcome arrives asynchronously; a missed push self-heals on
			// the child's next model request (before_agent_start re-check).
			const push = await pushToLiveChildren(enabled);
			const pushText =
				push === null
					? "subagent push result unknown (they self-heal on next request)"
					: push.error
						? `subagent push failed: ${push.error}`
						: `applied to ${push.acked}/${push.total} live subagents`;
			ui?.notify?.(`proxy ${enabled ? "enabled" : "disabled"} · ${state.url} · ${describeMain(enabled)}\n${pushText}`, "info");
		},
	});
}
