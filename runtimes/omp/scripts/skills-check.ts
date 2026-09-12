#!/usr/bin/env bun
/**
 * skills-check — validates no duplicate frontmatter `name` in
 * the skill discovery root (~/.omp/agent/skills/).
 *
 * Run during dotfiles sync/verification.
 * Exit code 1 on duplicates (with stderr report). Exit 0 on ok.
 */

const skillsRoot = process.env.HOME + "/.omp/agent/skills";
const { readdirSync, existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

function discover(root) {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const md = join(root, e.name, "SKILL.md");
    if (!existsSync(md)) continue;
    const text = readFileSync(md, "utf-8");
    const lines = text.split("\n").slice(0, 20);
    let name = "";
    for (const line of lines) {
      if (line.trim() === "---") continue;
      const m = line.match(/^name:\s*(.+)$/);
      if (m) { name = m[1].trim(); break; }
    }
    if (name) out.push({ name, dir: e.name });
  }
  return out;
}

const skills = discover(skillsRoot);
const byName = new Map();
for (const s of skills) {
  const dirs = byName.get(s.name) ?? [];
  dirs.push(s.dir);
  byName.set(s.name, dirs);
}
let ok = true;
for (const [name, dirs] of byName) {
  if (dirs.length > 1) {
    console.error(`duplicate skill name: "${name}"`);
    for (const d of dirs) console.error(`  path: ${skillsRoot}/${d}`);
    ok = false;
  }
}
if (!ok) process.exit(1);
console.log("skills-check: ok");
