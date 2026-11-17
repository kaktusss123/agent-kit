# Installation and skill discovery

Prerequisites: Node.js and Bash; repository dependencies for host hook tests per CONTRIBUTING.md. Codex CLI 0.166.0 is optional for the real discovery probe, which explicitly skips on other versions.

Drive:

```sh
tests/layout/run.sh
tests/skills/run.sh
tests/installer/run.sh
node --test tests/codex/*.test.mjs
node --test tests/skills/installation.test.mjs
```

Expected: all required checks pass. New portable skills are linked by normal installation for Pi, Claude Code and Codex, with the Pi reminder extension installed only for Pi. Foreign links and real user files survive conflict/reinstall/uninstall scenarios. The project-local verification map is not distributed as a universal `verify` skill.

Evidence: retain exit status, pass/fail/skip counts and any discovery diagnostics. Installer tests use an isolated HOME, not the active configuration. A missing pinned Codex CLI is a discovery coverage gap, not proof of discovery. No cleanup of user config is permitted.
