#!/usr/bin/env bun
/**
 * deploy-parity — compare managed task-runtime files between
 * dotfiles source and ~/.omp deployed state.
 *
 * Checks:
 *  - Task-runtime .ts files (source == deploy)
 *  - Skills (source == deploy, no duplicate frontmatter names)
 *  - Managed skills (source == deploy, deployed-only suspects reported)
 *  - Every skill://<name> reference resolves to an existing skill
 *
 * Does not touch config.yml (external modifications expected there).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

function sha256(p: string): string | null { try { return createHash("sha256").update(readFileSync(p)).digest("hex"); } catch { return null; } }
function fail(msg: string) { console.error(msg); return false; }

function check(name: string, src: string, dest: string): boolean {
  if (!existsSync(src)) return fail(`source missing: ${src}`);
  const s = sha256(src); if (s === null) return fail(`source unreadable: ${src}`);
  const d = sha256(dest); if (d === null) return fail(`deploy missing/unreadable: ${dest}`);
  if (s !== d) return fail(`content mismatch: ${name}`);
  return true;
}

const ROOT = import.meta.dir.replace("/scripts", "");
const DEPLOY = process.env.HOME + "/.omp/agent";
let ok = true;

// --- Task runtime .ts files ---
for (const f of ["commands.ts", "decisions.ts", "events.ts", "index.ts", "lifecycle.ts",
                 "paths.ts", "permissions.ts", "repos.ts", "snapshots.ts", "state.ts",
                 "storage.ts", "tools.ts", "types.ts", "verification.ts"]) {
  if (!check(f, join(ROOT, "extensions", "task-runtime", f), join(DEPLOY, "extensions", "task-runtime", f))) ok = false;
}

// --- Skills ---
const srcSkills = join(ROOT, "skills"), depSkills = join(DEPLOY, "skills");

function listDirs(d: string): string[] {
  if (!existsSync(d)) return [];
  try { return readdirSync(d, {withFileTypes:true}).filter(e => e.isDirectory() && !e.name.startsWith(".") && !e.name.match(/\.bak\b|\.bak\.\d/)).map(e => e.name); }
  catch { return []; }
}

const srcSkillDirs = listDirs(srcSkills);
const depSkillDirs = listDirs(depSkills);

// Deploy duplicate frontmatter names
const frontmatterNames = new Map<string, string[]>();
for (const dir of depSkillDirs) {
  const md = join(depSkills, dir, "SKILL.md");
  if (!existsSync(md)) continue;
  const c2 = readFileSync(md, "utf-8");
  const m2 = c2.match(/^name:\s*(.+)$/m);
  if (m2) {
    const n = m2[1].trim();
    const dirs = frontmatterNames.get(n) ?? [];
    dirs.push(dir);
    frontmatterNames.set(n, dirs);
  }
}
for (const [name, dirs] of frontmatterNames) {
  if (dirs.length > 1) { console.error("DUPLICATE skill name:", name, "=>", dirs); ok = false; }
}

// Deploy undeployed source skills
for (const dir of srcSkillDirs) {
  if (dir.match(/\.bak/)) continue;
  if (!depSkillDirs.includes(dir)) { ok = fail("deploy missing skill dir: " + dir); continue; }
  if (!check("skill:" + dir, join(srcSkills, dir, "SKILL.md"), join(depSkills, dir, "SKILL.md"))) ok = false;
}

// Cat: deployed-only skills (ckeck not in source)
for (const dir of depSkillDirs) {
  if (dir.match(/\.bak/)) continue;
  if (!srcSkillDirs.includes(dir)) { console.log("INFO: deployed-only skill dir: " + dir + " (not in source; may be user-managed)"); }
}

// --- Managed skills ---
const srcManaged = join(ROOT, "managed-skills"), depManaged = join(DEPLOY, "managed-skills");
const srcMDirs = listDirs(srcManaged), depMDirs = listDirs(depManaged);
for (const dir of srcMDirs) {
  if (!depMDirs.includes(dir)) { ok = fail("deploy missing managed skill: " + dir); continue; }
  if (!check("managed:"+dir, join(srcManaged,dir,"SKILL.md"), join(depManaged,dir,"SKILL.md"))) ok = false;
}
for (const dir of depMDirs) {
  if (!srcMDirs.includes(dir)) {
    console.log("INFO: deployed-only managed skill: " + dir + " (not in source; may be user-managed)");
  }
}

// WATCHDOG
if (!check("WATCHDOG", join(ROOT, "WATCHDOG.md"), join(DEPLOY, "WATCHDOG.md"))) ok = false;

// skill:// reference resolution
const allNames = new Set<string>();
for (const dir of depSkillDirs) {
  try {
    const c3 = readFileSync(join(depSkills, dir, "SKILL.md"), "utf-8");
    const m3 = c3.match(/^name:\s*(.+)$/m);
    if (m3) allNames.add(m3[1].trim());
  } catch {}
}
for (const dir of depSkillDirs) {
  try {
    const c4 = readFileSync(join(depSkills, dir, "SKILL.md"), "utf-8");
    for (const ref of c4.matchAll(/skill:\/\/([A-Za-z0-9:-]+)/g)) {
      const name = ref[1];
      if (!allNames.has(name)) {
        ok = fail("unresolved skill://" + name + " referenced from " + dir + "/SKILL.md");
      }
    }
  } catch {}
}

if (!ok) process.exit(1);
console.log("deploy-parity: OK");
