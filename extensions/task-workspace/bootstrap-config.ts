/**
 * Worktree dependency provisioning configuration, shared by both bindings
 * (the pi extension in index.ts and the CLI in cli.ts); the core stays
 * name-free. agent-kit has no root package.json, so its extension tests
 * resolve the pi runtime's packages through node_modules links, which
 * ensure_task_repo provisions automatically. AGENT_KIT_PI_ROOT overrides
 * discovery with an explicit package directory. No pi SDK imports here.
 */
import type { BootstrapConfig } from "./bootstrap.ts";

export const BOOTSTRAP_CONFIG: BootstrapConfig = {
  packages: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
    "typebox",
  ],
  overrideEnv: "AGENT_KIT_PI_ROOT",
  legacyRoot: "~/.local/lib/node_modules/@earendil-works/pi-coding-agent",
  cliName: "pi",
};
