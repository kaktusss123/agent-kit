/**
 * bootstrap — dependency provisioning for test-capable managed worktrees.
 *
 * A fresh managed worktree of a manifest-free extension repository (no root
 * package.json, tests importing the host runtime's packages) cannot resolve
 * those imports: there is no lockfile-driven installer for it, and node
 * module resolution from a task-root location never reaches a node_modules
 * directory. The historical workaround was a hand-maintained node_modules of
 * symlinks, which every fresh worktree had to redo manually.
 *
 * This module makes ensure_task_repo provision the worktree instead: it
 * discovers a package source on the machine and creates the missing
 * node_modules links inside the WORKTREE only — the source/primary checkout
 * is never touched. WHICH packages to link and where discovery may look is
 * host configuration (see BootstrapConfig, supplied by the extension
 * binding); the mechanics here are pure node/fs.
 *
 * Discovery order (first match wins):
 *   1. the override env var (BootstrapConfig.overrideEnv) pointing at the
 *      anchor package directory;
 *   2. the source repository's primary checkout `node_modules`, when it is
 *      already provisioned (every configured package resolves there);
 *   3. the running installation: ancestors of `process.execPath` and of this
 *      module directory probed for the anchor package (covers npm-global
 *      node and bun layouts);
 *   4. the anchor package's CLI executable on PATH, walked up to its
 *      package root;
 *   5. the legacy fallback directory (BootstrapConfig.legacyRoot).
 *
 * Provisioning is idempotent: links that already resolve to the discovered
 * source are kept untouched (a second ensure is a no-op), dangling links are
 * re-pointed, and real (non-symlink) entries are never clobbered — they fail
 * the run as skipped so a human can inspect. Repositories WITH a root
 * package.json are not applicable: their dependencies belong to their own
 * tooling (bun/npm install).
 *
 * Host-independent: node/fs only, no pi SDK imports, no host plumbing, and
 * no environment reads except through the injectable env parameter.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import type { BootstrapLink, BootstrapResult } from "./types.ts";

/** Host configuration for worktree dependency provisioning. The binding
 *  owns the concrete names; this core module stays name-free. */
export interface BootstrapConfig {
  /** Import-specifier names to link into the worktree node_modules. The
   *  first entry anchors discovery (its installed package directory). */
  packages: string[];
  /** Env var overriding discovery with the anchor package directory. */
  overrideEnv: string;
  /** Fallback directory of the anchor package when nothing is discovered. */
  legacyRoot: string;
  /** Executable name on PATH used to locate the anchor package root. */
  cliName: string;
}

type PackageSource =
  | { kind: "install_root"; root: string }
  | { kind: "node_modules"; dir: string };

type Env = Record<string, string | undefined>;

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function packageNameOf(packageDir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      name?: unknown;
    };
    return typeof pkg.name === "string" ? pkg.name : null;
  } catch {
    return null;
  }
}

function isPackageRoot(p: string, name: string): boolean {
  return isDir(p) && packageNameOf(p) === name;
}

/** Concrete source path for one package, validated to exist under its
 *  declared name. */
function packageSourcePath(source: PackageSource, anchor: string, name: string): string | null {
  const candidate =
    source.kind === "install_root"
      ? name === anchor
        ? source.root
        : join(source.root, "node_modules", name)
      : join(source.dir, name);
  return isDir(candidate) && packageNameOf(candidate) === name ? candidate : null;
}

function probeNodeModulesDir(dir: string, packages: string[]): PackageSource | null {
  const base = join(dir, "node_modules");
  if (!isDir(base)) return null;
  // A trusted package source must resolve EVERY configured package; a
  // partially provisioned node_modules is not.
  for (const name of packages) {
    if (!isPackageRoot(join(base, name), name)) return null;
  }
  return { kind: "node_modules", dir: base };
}

/** Ancestors of `start`, innermost first, ending at the filesystem root. */
function ancestors(start: string): string[] {
  const out: string[] = [];
  for (let dir = start; ; dir = dirname(dir)) {
    out.push(dir);
    if (dirname(dir) === dir) break;
  }
  return out;
}

function findPackageRootFrom(starts: string[], anchor: string): PackageSource | null {
  for (const start of starts) {
    for (const dir of ancestors(start)) {
      const candidates = [join(dir, "node_modules", anchor)];
      if (basename(dir) === "node_modules") candidates.push(join(dir, anchor));
      // npm global prefix layout: <prefix>/bin/<runtime> and
      // <prefix>/lib/node_modules/<scope>/<pkg>.
      candidates.push(join(dir, "lib", "node_modules", anchor));
      for (const candidate of candidates) {
        if (isPackageRoot(candidate, anchor)) return { kind: "install_root", root: candidate };
      }
    }
  }
  return null;
}

/** Walk up from a CLI executable on PATH to its package root. */
function packageRootFromPath(pathEnv: string, cliName: string, anchor: string): PackageSource | null {
  for (const entry of pathEnv.split(":")) {
    if (!entry) continue;
    const candidate = join(entry, cliName);
    if (!existsSync(candidate)) continue;
    for (const dir of ancestors(dirname(candidate))) {
      if (isPackageRoot(dir, anchor)) return { kind: "install_root", root: dir };
      if (existsSync(join(dir, "package.json"))) break;
    }
  }
  return null;
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Discover the machine's package source for the configured packages. `env`
 * and the walk starts are parameters so tests can run without ambient state.
 */
export function discoverDependencySource(
  config: BootstrapConfig,
  opts: {
    env: Env;
    primaryDir?: string | null;
    walkStarts?: string[];
    pathEnv?: string;
  },
): PackageSource | null {
  const anchor = config.packages[0]!;
  const override = opts.env[config.overrideEnv]?.trim();
  if (override) {
    const expanded = expandTilde(override);
    if (isPackageRoot(expanded, anchor)) return { kind: "install_root", root: expanded };
  }
  if (opts.primaryDir) {
    const fromPrimary = probeNodeModulesDir(opts.primaryDir, config.packages);
    if (fromPrimary) return fromPrimary;
  }
  const walkStarts = opts.walkStarts ?? [
    dirname(process.execPath),
    dirname(fileURLToPath(import.meta.url)),
  ];
  const fromWalk = findPackageRootFrom(walkStarts, anchor);
  if (fromWalk) return fromWalk;
  const fromPath = packageRootFromPath(opts.pathEnv ?? opts.env.PATH ?? "", config.cliName, anchor);
  if (fromPath) return fromPath;
  const legacy = expandTilde(config.legacyRoot);
  if (isPackageRoot(legacy, anchor)) return { kind: "install_root", root: legacy };
  return null;
}

/**
 * Provision one managed worktree so its test suite can resolve the
 * configured packages. Never touches the source/primary checkout;
 * idempotent by link inspection (already-correct links are kept, not
 * recreated).
 */
export async function bootstrapWorktreeDependencies(
  worktree: string,
  config: BootstrapConfig,
  opts: { env: Env; primaryDir?: string | null },
): Promise<BootstrapResult> {
  if (existsSync(join(worktree, "package.json"))) {
    return {
      status: "not_applicable",
      links: [],
      reason: "repository has a root package.json; dependencies belong to its own tooling",
    };
  }
  let hasExtensions = false;
  try {
    hasExtensions = readdirSync(join(worktree, "extensions")).length > 0;
  } catch {
    hasExtensions = false;
  }
  if (!hasExtensions) {
    return {
      status: "not_applicable",
      links: [],
      reason: "repository has no extensions/ directory; nothing known to provision",
    };
  }
  const source = discoverDependencySource(config, { env: opts.env, primaryDir: opts.primaryDir });
  if (!source) {
    return {
      status: "skipped",
      links: [],
      reason: `no ${config.packages[0]} installation found; set ${config.overrideEnv} to the package directory`,
    };
  }

  const anchor = config.packages[0]!;
  const nodeModules = join(worktree, "node_modules");
  mkdirSync(nodeModules, { recursive: true });
  const links: BootstrapLink[] = [];
  let changed = false;
  let conflicted = false;
  for (const name of config.packages) {
    const target = join(nodeModules, ...name.split("/"));
    const src = packageSourcePath(source, anchor, name);
    if (!src) {
      links.push({ name, source: "", target, action: "source_missing" });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    let action: BootstrapLink["action"];
    try {
      const st = lstatSync(target);
      if (st.isSymbolicLink()) {
        let current: string | null = null;
        try {
          current = realpathSync(target);
        } catch {
          current = null; // dangling link
        }
        if (current === realpathSync(src)) {
          action = "kept";
        } else {
          rmSync(target);
          symlinkSync(src, target);
          action = "repointed";
          changed = true;
        }
      } else {
        // A real file or directory: never clobber user content.
        action = "conflict";
        conflicted = true;
      }
    } catch {
      symlinkSync(src, target);
      action = "created";
      changed = true;
    }
    links.push({ name, source: src, target, action });
  }

  if (conflicted) {
    return {
      status: "skipped",
      links,
      reason:
        "node_modules contains non-symlink entries; they were left untouched — inspect manually",
    };
  }
  return {
    status: changed ? "provisioned" : "current",
    links,
  };
}
