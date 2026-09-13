---
description: Task discovery and specification — resolve the task, investigate the managed worktree, produce the canonical SPEC
argument-hint: "[task]"
---

Enter specification mode for: ${@:-the goal already agreed in this conversation}. If there is no agreed goal, ask the user what to specify before doing anything else.

Main owns discovery: intent, user conversation, product and design decisions, synthesis, and the canonical specification. Do not implement product code unless the user explicitly leaves this workflow.

Work per `skill://git-task`:

- Resolve or continue the task identity, and establish the canonical managed worktree(s) before substantive repository analysis.
- Once the worktree exists, repository evidence comes from the managed worktree: read files and run inspection commands by its explicit path, or root bounded research subagents there (`subagent op=spawn` with `cwd` set to the worktree). The dirty source checkout is no longer repository evidence for this task, and this session's cwd does not change.
- Use `skill://grilling`, `skill://system-understanding`, `skill://engineering-research`, `skill://code-archaeology`, or `skill://prototype` as the task demands, and `skill://specification` for the final contract.

Write or update `SPEC.md` in the task workspace as the canonical entrypoint (multi-repo: cross-repo contract, writable repositories, dependencies, integration acceptance). Done when implementation would not require guessing product intent.
