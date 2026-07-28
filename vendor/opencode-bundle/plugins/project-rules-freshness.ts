import type { Plugin, Hooks } from "@opencode-ai/plugin";
import { execFile } from "child_process";
import { readFile, access } from "fs/promises";
import { join, resolve } from "path";
import { promisify } from "util";
import { homedir } from "os";

// Project-rules freshness plugin.
// Reads local AGENTS.md and .opencode/agents-freshness.json on session.created
// to detect staleness. Fails open; never mutates, never reaches network.
// Kill-switch: OPENCODE_PROJECT_RULES_FRESHNESS=0 disables the plugin.

const KILL_SWITCH = "OPENCODE_PROJECT_RULES_FRESHNESS";
const GLOBAL_CONFIG_ROOT = resolve(homedir(), ".config", "opencode");

// In-memory cooldown: directory -> timestamp of last notification.
// Prevents repeated toasts across sessions without file writes.
const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
const cooldown = new Map<string, number>();

const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 1024 * 1024; // 1 MB

const execFileAsync = promisify(execFile);

function isCoolingDown(directory: string): boolean {
  const last = cooldown.get(directory);
  if (!last) return false;
  return Date.now() - last < COOLDOWN_MS;
}

function markNotified(directory: string): void {
  cooldown.set(directory, Date.now());
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
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

  // Skip freshness checks in the global opencode config root;
  // its AGENTS.md is global, not project-specific.
  if (resolve(projectRoot) === GLOBAL_CONFIG_ROOT) {
    return {};
  }

  const log = (level: "debug" | "info" | "warn" | "error", message: string) => {
    client?.app?.log({
      body: { service: "freshness", level, message },
      query: { directory: projectRoot },
    }).catch(() => {});
  };

  const showToast = (title: string, message: string, variant: "info" | "warning" = "info") => {
    client?.tui?.showToast({
      body: { title, message, variant, duration: 6000 },
      query: { directory: projectRoot },
    }).catch(() => {});
  };

  return {
    event: async ({ event }) => {
      if (event.type !== "session.created") return;

      try {
        const agentsPath = join(projectRoot, "AGENTS.md");
        const freshnessPath = join(projectRoot, ".opencode", "agents-freshness.json");

        if (!await pathExists(agentsPath)) {
          log("info", "AGENTS.md not found in project root; skipping freshness check");
          return;
        }

        if (!await pathExists(freshnessPath)) {
          if (!isCoolingDown(projectRoot)) {
            log("info", "agents-freshness.json not found; project may need /init");
            showToast("Project onboarding", "Run /init to create AGENTS.md", "warning");
            markNotified(projectRoot);
          }
          return;
        }

        const freshnessRaw = await readFile(freshnessPath, "utf-8");
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

        // Check git history for changes since lastVerified using async execFile
        const since = lastVerifiedDate.toISOString();
        const result = await execFileAsync(
          "git",
          ["log", `--since=${since}`, "--name-only", "--pretty=format:", "--", "."],
          {
            cwd: projectRoot,
            encoding: "utf-8",
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: GIT_MAX_BUFFER,
          }
        );

        const output = (result.stdout as string).trim();

        if (output.length > 0) {
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
