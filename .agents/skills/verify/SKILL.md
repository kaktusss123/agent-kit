---
name: verify
description: "Verify agent-kit installation, managed worktree ownership, and Pi skill reflection through isolated project scenarios. Use when a change touches those user paths or when auditing this repository's verification coverage."
---

# Verify agent-kit

This is agent-kit's project-local coverage map, not a skill shipped to every installed project. Read `features/README.md`, select scenarios that observe the changed behavior and its risks, and report commands, observed results and gaps. Do not run every scenario on every change.

Use the dependency bootstrap, isolation and cleanup contract in [CONTRIBUTING.md](../../../CONTRIBUTING.md). Do not install into the active user's config, use credentials, call a model, push, or change another checkout. Tests create and clean only their own sandboxes; preserve command output outside disposable test roots when evidence is needed.

Pi 1.5.0 discovers this project `.agents/skills/` directory after project trust. Codex CLI 0.166.0 discovers the same location. Claude Code does not automatically discover this shared project path: read this file explicitly. No extra host hook is installed for this map.

If a recipe fails, distinguish stale instructions, a harness/environment gap, and a product regression. Retain failing evidence before cleanup. Repair the right layer; never weaken an expected result to hide a regression. Mark unavailable observations as blocked, not passed.
