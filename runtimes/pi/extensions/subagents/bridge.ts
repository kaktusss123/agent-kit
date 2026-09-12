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
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildChildAskTool } from "./bridge-ask";

export default function (pi: ExtensionAPI) {
	pi.registerTool(buildChildAskTool());
}
