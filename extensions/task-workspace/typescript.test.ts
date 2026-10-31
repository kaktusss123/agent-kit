import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
const TSC_OVERRIDE = "AGENT_KIT_TSC";

function tscFromPath(input: string): string | null {
  const absolute = isAbsolute(input) ? input : resolve(process.cwd(), input);
  const candidates = [absolute, join(absolute, "lib", "tsc.js")];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

function executableOnPath(name: string): string | null {
  for (const entry of (process.env.PATH ?? "").split(":")) {
    if (!entry) continue;
    const base = isAbsolute(entry) ? entry : resolve(process.cwd(), entry);
    const candidate = join(base, name);
    try {
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

function piPackageRoot(): string | null {
  const pi = executableOnPath("pi");
  if (!pi) return null;
  let current = dirname(pi);
  for (;;) {
    const packageJson = join(current, "package.json");
    if (existsSync(packageJson)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJson, "utf8")) as { name?: string };
        if (pkg.name === "@earendil-works/pi-coding-agent") return current;
      } catch {
        return null;
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function locateTsc(): { tsc: string; piRoot: string | null } | null {
  const override = process.env[TSC_OVERRIDE]?.trim();
  if (override) {
    const tsc = tscFromPath(override);
    if (tsc) return { tsc, piRoot: piPackageRoot() };
  }
  const piRoot = piPackageRoot();
  if (!piRoot) return null;
  const tsc = tscFromPath(join(piRoot, "node_modules", "typescript"));
  return tsc ? { tsc, piRoot } : null;
}

const installation = locateTsc();

if (!installation) {
  test(
    `task-workspace TypeScript static check unavailable; set ${TSC_OVERRIDE} to tsc.js or a TypeScript directory`,
    { skip: true },
    () => {},
  );
} else {
  test("task-workspace passes the optional strict TypeScript static check", () => {
    let project = join(import.meta.dirname, "tsconfig.json");
    let generatedConfigDir: string | null = null;
    if (installation.piRoot) {
      generatedConfigDir = mkdtempSync(join(tmpdir(), "agent-kit-tsc-config-"));
      project = join(generatedConfigDir, "tsconfig.json");
      writeFileSync(
        project,
        JSON.stringify({
          extends: join(import.meta.dirname, "tsconfig.json"),
          compilerOptions: {
            baseUrl: "/",
            paths: {
              "@earendil-works/pi-coding-agent": [installation.piRoot],
              typebox: [join(installation.piRoot, "node_modules", "typebox")],
            },
            typeRoots: [join(installation.piRoot, "node_modules", "@types")],
          },
        }),
      );
    }

    try {
      const result = spawnSync(
        process.execPath,
        [installation.tsc, "--project", project, "--pretty", "false"],
        {
          cwd: import.meta.dirname,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.status, output || result.error?.message).toBe(0);
      expect(output).toBe("");
    } finally {
      if (generatedConfigDir) {
        rmSync(generatedConfigDir, { recursive: true, force: true });
      }
    }
  });
}
