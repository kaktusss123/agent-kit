import type { Plugin } from "@opencode-ai/plugin";

const MIN_RTK_MAJOR = 0;
const MIN_RTK_MINOR = 23;

type Semver = {
  major: number;
  minor: number;
  patch: number;
};

function parseVersion(input: string): Semver | null {
  const match = input.match(/(\d+)\.(\d+)\.(\d+)/);

  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function isSupportedVersion(version: Semver | null): boolean {
  if (!version) {
    return true;
  }

  if (version.major > MIN_RTK_MAJOR) {
    return true;
  }

  return version.major === MIN_RTK_MAJOR && version.minor >= MIN_RTK_MINOR;
}

export const RtkRewritePlugin: Plugin = async ({ $ }) => {
  const hasRtk = (await $`command -v rtk`.quiet().nothrow()).exitCode === 0;

  if (!hasRtk) {
    return {};
  }

  const versionResult = await $`rtk --version`.quiet().nothrow();
  const version = versionResult.exitCode === 0 ? parseVersion(versionResult.text()) : null;

  if (!isSupportedVersion(version)) {
    return {};
  }

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") {
        return;
      }

      const rawCommand = typeof output.args?.command === "string" ? output.args.command : "";
      const command = rawCommand.trim();

      if (!command) {
        return;
      }

      const rewrittenResult = await $`rtk rewrite ${command}`.quiet().nothrow();

      if (rewrittenResult.exitCode !== 0) {
        return;
      }

      const rewrittenCommand = rewrittenResult.text().trim();

      if (!rewrittenCommand || rewrittenCommand === command) {
        return;
      }

      output.args.command = rewrittenCommand;
    },
  };
};
