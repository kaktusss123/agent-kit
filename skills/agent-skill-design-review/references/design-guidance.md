# Design Guidance for Agent and Skill Design

**Status:** Advisory, not SSOT. User decisions, local OpenCode docs, and repository evidence override these recommendations.

These recommendations are sourced from external articles and validated against local OpenCode behavior. They are useful guidelines, not mandatory rules.

## 1. Skill Authoring

### Concise SKILL.md

- Keep SKILL.md body under 500 lines for optimal performance.
- Use SKILL.md as an overview that points to detailed materials as needed.
- Move domain-specific workflows, templates, and detailed logic into reference files.

### Progressive Disclosure

- SKILL.md contains: purpose, triggers, quick reference, high-level process, anti-patterns, verification checklist.
- Reference files contain: detailed templates, domain knowledge, complex workflows, evaluation criteria.
- Load references only when the task requires them.

### Evaluation-Driven Design

- Create evaluation scenarios before writing extensive documentation.
- Define what "good" looks like with concrete validation criteria.
- Test the skill with real usage before finalizing.

## 2. Agent Architecture

### Simplicity Over Complexity

- Use simple, composable patterns rather than complex frameworks.
- Find the simplest solution that works; increase complexity only when needed.
- Distinguish workflows (predefined code paths) from agents (dynamic self-direction).

### Ground Truth and Stopping Conditions

- Gain ground truth from the environment at each step.
- Include stopping conditions (maximum iterations, timeout) to maintain control.
- Base factual claims on file evidence, command output, or official documentation.

### Context Engineering

- Context is a critical but finite resource.
- Find the smallest possible set of high-signal tokens.
- Use just-in-time retrieval: lightweight identifiers that dynamically load data at runtime.

## 3. Permission and Security

### Least-Privilege Design

- Deny all operations by default; allow only what is necessary.
- Separate read, write, and execute permissions clearly.
- Deny delegation unless explicitly required for the agent's role.

### Secret Handling

- Never embed secret values in agent definitions, skills, or generated documentation.
- Use clear placeholders and explain expected secret sources.
- Apply secret-scan heuristics before writing any generated content.

### Network and Remote Operations

- Deny remote git, network, cloud, SSH, and PR operations for local-only workflows.
- Prefer dry-run, diff, and reversible changes for mutation operations.
- Require explicit confirmation before destructive operations.

## 4. OpenCode-Specific Constraints

### Skill Discovery

- Skills are discovered from `~/.config/opencode/skills/<name>/SKILL.md` (global) or `.opencode/skills/<name>/SKILL.md` (project).
- Custom commands can override built-in commands through frontmatter.
- Plugins are auto-loaded from `~/.config/opencode/plugins/` and `.opencode/plugins/`.

### Plugin APIs

- Plugins are JavaScript/TypeScript modules exporting plugin functions.
- Plugin context includes: `project`, `directory`, `worktree`, `client`, `$`.
- Events include: `session.created`, `tool.execute.before`, `tool.execute.after`, and others.
- Use `client.app.log()` for structured logging instead of `console.log`.

### Permission Model

- Agent permissions use glob patterns with `allow`, `deny`, and `ask` actions.
- Permission frontmatter may not express all dynamic constraints; document enforcement in the agent body when needed.
- Subagent delegation is controlled by the `task` permission block.

## 5. Validation Checklist

When reviewing any agent or skill design, verify:

- [ ] SKILL.md is concise and uses progressive disclosure
- [ ] Permissions are least-privilege with explicit denials
- [ ] Delegation is limited and intentional
- [ ] Evaluation scenarios are defined
- [ ] Secret handling follows the heuristic
- [ ] Local-only workflows deny remote operations
- [ ] Override hierarchy is respected (user > local docs > evidence > external)
