/**
 * Child-side bridge extension for subagents.
 *
 * Loaded into every subagent via `pi --mode rpc --no-extensions -e bridge.ts`.
 * It provides exactly one capability beyond the normal coding tools: `ask`,
 * the canonical model-facing question tool (see ../ask/contract.ts). The call
 * suspends only this child until the controller/Main answers through the
 * standard RPC extension_ui_request/response protocol; the answer text
 * resumes the very same tool call.
 *
 * The bridge registers nothing else and never loads the parent's extension
 * stack, so recursive spawning is impossible by construction. The child
 * model never sees any parent/routing concept — in every role the tool is
 * just `ask`.
 *
 * Proxy: the machine-level preference (../proxy-lib.ts, proxy-state.json) is
 * applied at session_start and re-checked before each model request, so new
 * children start in the persisted mode and self-heal to it even if a live
 * push from Main was missed. The `proxy` command is the push target Main
 * invokes over the existing RPC prompt path; it re-applies the persisted
 * preference (the file, not the argument, is the truth).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildChildAskTool } from "./bridge-ask.ts";
import { applyProxyPreference, reapplyIfDrifted } from "../proxy/proxy-lib.ts";

export default function (pi: ExtensionAPI) {
	pi.registerTool(buildChildAskTool());

	pi.on("session_start", async () => {
		await applyProxyPreference();
	});

	pi.on("before_agent_start", async () => {
		await reapplyIfDrifted();
	});

	pi.registerCommand("proxy", {
		description: "Apply the machine proxy preference in this child (/proxy on|off)",
		handler: async () => {
			// The persisted preference is the single source of truth; the push
			// is only a wake-up. No ctx.ui here: this child runs in RPC mode.
			await applyProxyPreference();
		},
	});
}
