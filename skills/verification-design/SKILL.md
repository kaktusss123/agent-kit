---
name: verification-design
description: "Design the smallest trustworthy verification plan for a software change. Use when: planning, implementation planning, review, or task cracking requires choosing commands, tests, scripts, or manual checks that actually observe the requested behavior and important failure modes; changing observable behavior needs a project-local harness for launch, health, drive, evidence, and cleanup. Not for: writing the failing test itself; use skill://tdd."
---

# Verification design

A verification check earns its place only if it can falsify a meaningful claim. In a task workflow (`skill://git-task`), a RepoOwner loads this when changing observable behavior, before choosing the checks.

## Discover existing checks first

Inspect project scripts, Makefiles, CI, test layout, contribution docs, and nearby precedent. Prefer canonical project checks over invented commands.

## Map claims to evidence

For each material acceptance claim, ask:

- What observable would prove or disprove it?
- What is the highest practical seam that sees that observable?
- What existing focused command reaches that seam?
- Which failures need a dedicated regression test or reproduction script?

Prefer a focused deterministic check when it proves the claim. Add broad suites when project policy requires them or the change has a wide enough impact that focused checks cannot cover it.

## Avoid false confidence

Do not use:
- compile success as proof of runtime behavior;
- a unit test that bypasses the integration being changed;
- snapshots that cannot fail on the requested behavior;
- manual inspection when a cheap deterministic check exists.

A negative or blocking conclusion needs a positive control through the same probe path when feasible. Prove that the probe can observe a known-success case before trusting its failure result.

Treat a command or tool failure, malformed response, or unclassified timeout as probe failure, not product success. A timeout counts as product evidence only when it is the explicitly expected observable, the probe is bounded, and a same-path positive control succeeds. If the harness cannot observe the claim, record the check as `NOT_RUN` or blocked and state why.

Verify the complete user-visible contract relevant to the claim, not one convenient field. For tabular results, this means status, columns or schema, and rows.

If deterministic verification is unavailable, say exactly what remains manual and why.

## Project-local harness

When CLI, API, UI, service, or integration behavior needs a repeatable way to be observed, establish it in the repository instead of rediscovering it per session.

Determine and record:
- **Surface**: what users or integrations actually touch;
- **Launch**: canonical local start/build command and readiness signal;
- **Doctor**: read-only health/version/config check;
- **Drive**: stable programmatic way to exercise the real path;
- **Evidence**: outputs that prove action and resulting state;
- **Isolation**: ports, profiles, data dirs, or limits on parallel instances;
- **Cleanup**: how to stop only what the verification run started.

Prefer existing harnesses. Do not invent a second testing stack when Playwright, pytest, an integration CLI, curl scripts, or similar already solve the problem. Store the guidance where the repository keeps agent/project guidance, name exact commands/selectors/endpoints and the expected evidence, keep secrets and personal paths out of shared files. Run one representative end-to-end path using the written instructions: a guide that has never been executed is a draft.

## Project-local verification map

For a project that needs repeatable scenario coverage, generate and maintain a **project-specific** verification skill committed with that project, not a single prewritten skill for every project. Follow its existing skill convention. If none exists, prefer `.agents/skills/verify/`: Pi 1.5.0 and [Codex CLI 0.166.0](https://developers.openai.com/codex/skills/) discover project `.agents/skills/` from the working directory to the repository root. [Claude Code](https://code.claude.com/docs/en/skills) documents `.claude/skills/`, not this shared project path: explicitly read `.agents/skills/verify/SKILL.md` there, or use an authorized project-local binding to the same source. Verify discovery for each supported host and its configuration; do not claim universal automatic loading.

Create `SKILL.md`, `features/README.md` and a small set of focused scenario files under `features/`. The skill points to the index and the existing harness contract above rather than duplicating launch, doctor, drive, evidence, isolation or cleanup instructions. The index maps user entry points and capabilities to scenarios, including known gaps. Each scenario gives prerequisites, exact steps or commands, expected observable state and side effects, evidence to retain, and relevant gotchas. Include both success and important failure paths where applicable. Use project-real commands, not generic placeholders, and execute a representative scenario before calling the map ready.

Select scenarios relevant to a change and its risks; the map is a recipe and coverage guide, not a mandatory full sweep. On maintenance, distinguish stale instructions from harness gaps and product regressions. Preserve evidence after cleanup and never weaken an expected outcome to conceal a bug. Record gaps or blocked checks explicitly.

Adapted from ideas in [pstack create-verification-skill](https://github.com/cursor/plugins/tree/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/skills/create-verification-skill), Lauren Tan, 2026.

A task workflow (`skill://git-task`) may consume this capability when choosing task-specific gates; the capability itself must remain directly useful on its own.

## Output

Produce a compact, evidence-oriented verification contract:
- check name;
- where it runs;
- exact command or procedure;
- requirement it observes;
- required vs advisory/manual status.
