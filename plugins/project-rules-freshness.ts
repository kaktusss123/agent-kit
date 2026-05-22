import type { Plugin, Hooks } from "@opencode-ai/plugin";

// Project-rules freshness plugin.
// Reads local AGENTS.md and .opencode/agents-freshness.json on session.created
// to detect staleness. Fails open; never mutates, never reaches network.
// Kill-switch: OPENCODE_PROJECT_RULES_FRESHNESS=0 disables the plugin.

const KILL_SWITCH = "OPENCODE_PROJECT_RULES_FRESHNESS";

// In-memory cooldown: directory -> timestamp of last notification.
// Prevents repeated toasts across sessions without file writes.
const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
const cooldown = new Map<string, number>();

function isCoolingDown(directory: string): boolean {
  const last = cooldown.get(directory);
  if (!last) return false;
  return Date.now() - last < COOLDOWN_MS;
}

function markNotified(directory: string): void {
  cooldown.set(directory, Date.now());
}

export const ProjectRulesFreshnessPlugin: Plugin = async (input): Promise<Hooks> => {
  // Respect kill-switch
  const env = process.env[KILL_SWITCH];
  if (env === "0" || env === "false") {
    return {};
  }

  const { client, directory, worktree } = input;
  // Prefer worktree for project-root resolution when available
  const projectRoot = worktree || directory;

  const log = (level: "debug" | "info" | "warn" | "error", message: string) => {
    client?.app?.log({
      body: { service: "freshness", level, message },
      query: { directory: projectRoot },
    }).catch(() => {});
  };

  const showToast = (title: string, message: string, variant: "info" | "warning" = "info") => {
    client?.tui?.showToast({
      directory: projectRoot,
      title,
      message,
      variant,
      duration: 6000,
    }).catch(() => {});
  };

  return {
    event: async ({ event }) => {
      if (event.type !== "session.created") return;

      try {
        const fs = await import("fs");
        const path = await import("path");

        const agentsPath = path.join(projectRoot, "AGENTS.md");
        const freshnessPath = path.join(projectRoot, ".opencode", "agents-freshness.json");

        if (!fs.existsSync(agentsPath)) {
          log("info", "AGENTS.md not found in project root; skipping freshness check");
          return;
        }

        if (!fs.existsSync(freshnessPath)) {
          if (!isCoolingDown(projectRoot)) {
            log("info", "agents-freshness.json not found; project may need /init");
            showToast("Project onboarding", "Run /init to create AGENTS.md", "warning");
            markNotified(projectRoot);
          }
          return;
        }

        const freshnessRaw = fs.readFileSync(freshnessPath, "utf-8");
        const freshness = JSON.parse(freshnessRaw) as { lastVerified?: string };
        const lastVerified = freshness.lastVerified;

        if (!lastVerified) {
          log("info", "agents-freshness.json has no lastVerified field");
          return;
        }

        const lastVerifiedDate = new Date(lastVerified);
        if (isNaN(lastVerifiedDate.getTime())) {
          log("warn", "agents-freshness.json has invalid lastVerified date");
          return;
        }

        // Check git history for changes since lastVerified
        const { execSync } = await import("child_process");
        const since = lastVerifiedDate.toISOString();
        const result = execSync(
          `git log --since="${since}" --name-only --pretty=format: -- .`,
          { cwd: projectRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
        ).trim();

        if (result.length > 0) {
          if (!isCoolingDown(projectRoot)) {
            log("warn", "Project files changed since last AGENTS.md verification");
            showToast("Rules may be stale", "Run /init --check to verify AGENTS.md", "warning");
            markNotified(projectRoot);
          }
        } else {
          log("info", "Project rules are fresh");
        }
      } catch (err) {
        // Fail open: log but do not block session
        log("warn", `Freshness check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
};
