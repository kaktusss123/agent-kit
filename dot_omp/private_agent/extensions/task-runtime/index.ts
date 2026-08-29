import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerTaskRuntimeCommands } from "./commands.ts";
import { registerTaskRuntimeTools } from "./tools.ts";
import { registerWritePolicy } from "./permissions.ts";

export default function (pi: ExtensionAPI): void {
  pi.logger.info("[task-runtime] V2 loading");
  registerTaskRuntimeCommands(pi);
  registerTaskRuntimeTools(pi);
  registerWritePolicy(pi);
  pi.logger.info("[task-runtime] V2 loaded");
}
