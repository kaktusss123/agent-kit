#!/usr/bin/env bun
/**
 * deploy-parity — compare managed task-runtime files between
 * dotfiles source and ~/.omp deployed state.
 *
 * Does not touch config.yml (external modifications are expected there).
 * Checks: task-runtime .ts files, skills/SKILL.md, WATCHDOG.md.
 */

import { existsSync } from "node:fs";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

function sha256(p: string): string | null {
  try { return createHash("sha256").update(readFileSync(p)).digest("hex"); }
  catch { return null; }
}

function fail(msg: string) { console.error(msg); return false; }

function check(name: string, src: string, dest: string): boolean {
  if (!existsSync(src)) return fail(`source missing: ${src}`);
  const s = sha256(src);
  if (s === null) return fail(`source unreadable: ${src}`);
  const d = sha256(dest);
  if (d === null) return fail(`deploy missing/unreadable: ${dest}`);
  if (s !== d) return fail(`content mismatch: ${name}`);
  return true;
}

const ROOT = import.meta.dir.replace("/scripts", "");  // up into private_agent/
const DEPLOY = process.env.HOME + "/.omp/agent";
let ok = true;

// Task runtime .ts files
for (const f of ["commands.ts", "decisions.ts", "events.ts", "index.ts", "lifecycle.ts",
                 "paths.ts", "permissions.ts", "repos.ts", "snapshots.ts", "state.ts",
                 "storage.ts", "tools.ts", "types.ts", "verification.ts"]) {
  if (!check(f, join(ROOT, "extensions", "task-runtime", f), join(DEPLOY, "extensions", "task-runtime", f))) ok = false;
}

// Skills
for (const skill of ["cracker", "implementer"]) {
  if (!check(`skill:${skill}`, join(ROOT, "skills", skill, "SKILL.md"), join(DEPLOY, "skills", skill, "SKILL.md"))) ok = false;
}

// WATCHDOG
if (!check("WATCHDOG", join(ROOT, "WATCHDOG.md"), join(DEPLOY, "WATCHDOG.md"))) ok = false;

// Managed skills
for (const s of ["rtl-v4-clause-pollution-fix", "rtl-v4-fix-clause-pollution", "rtl-v4-repair-polluted-proposals", "rtl-v4-state-verification", "omp-extension-verify"]) {
  if (!check(`managed:${s}`, join(ROOT, "managed-skills", s, "SKILL.md"), join(DEPLOY, "managed-skills", s, "SKILL.md"))) ok = false;
}

if (!ok) process.exit(1);
console.log("deploy-parity: OK");
