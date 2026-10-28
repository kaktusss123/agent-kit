---
description: Task discovery and specification — resolve the task, investigate the managed worktree, produce the canonical SPEC
argument-hint: "[task]"
---

Enter specification mode for: $ARGUMENTS. If that is empty, use the goal already agreed in this conversation; if there is none, ask the user what to specify before doing anything else.

Main owns discovery: intent, user conversation, product and design decisions, synthesis, and the canonical specification. Do not implement product code unless the user explicitly leaves this workflow.

Work per `skill://git-task` (Claude Code contracts: its `references/claude-code/`):

- Resolve or continue the task identity, and establish the canonical managed worktree(s) with `agent-kit task ensure` before substantive repository analysis.
- Once the worktree exists, repository evidence comes from the managed worktree: read files and run inspection commands by its explicit absolute path, or give bounded research subagents (Agent tool, `Explore` agent type) that path as their only root. The dirty source checkout is no longer repository evidence for this task, and this session's cwd does not change.
- Use `skill://grilling`, `skill://system-understanding`, `skill://engineering-research`, `skill://code-archaeology`, or `skill://prototype` as the task demands, and `skill://specification` for the final contract.

Write or update `SPEC.md` in the task workspace (the directory containing the worktrees, from `agent-kit task status`) as the canonical entrypoint (multi-repo: cross-repo contract, writable repositories, dependencies, integration acceptance). Done when implementation would not require guessing product intent.
