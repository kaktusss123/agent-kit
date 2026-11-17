# Installation and skill discovery

Prerequisites: Node.js and Bash; repository dependencies for host hook tests per CONTRIBUTING.md. Pi 1.5.0, Claude Code and Codex CLI 0.166.0 are optional for real host discovery probes; unavailable hosts (or a mismatched pinned Pi/Codex protocol) explicitly skip.

Drive:

```sh
tests/layout/run.sh
tests/skills/run.sh
tests/installer/run.sh
node --test tests/codex/*.test.mjs
node --test tests/skills/*.test.mjs
```

Expected: all required checks pass. New portable skills are linked by normal installation for Pi, Claude Code and Codex, with the Pi reminder extension installed only for Pi. Foreign links and real user files survive conflict/reinstall/uninstall scenarios. The project-local verification map is not distributed as a universal `verify` skill.

Evidence: retain exit status, pass/fail/skip counts and any discovery diagnostics. Installer tests use an isolated HOME, not the active configuration. Pi RPC `get_commands`, Claude Code stream-JSON `initialize`, and Codex `debug prompt-input` inspect actual installed skill discovery without a prompt or model call. Missing supported CLIs are discovery coverage gaps, not proof of discovery. Static guardrail tests observe the written contract, not whether a model follows natural-language instructions. No cleanup of user config is permitted.
