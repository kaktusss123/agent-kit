# GitHub with gh

Use this reference only after GitHub is the selected publication target.

## Target resolution

Require the GitHub host and repository to be explicit before publication. Support github.com and GitHub Enterprise hosts equally. Do not infer GitHub from a hard-coded hostname list beyond what the user or repository context establishes.

If the target is ambiguous, inspect read-only remotes only to present candidates. Let the user choose.

## Minimal preflight

1. Verify `gh` exists with `command -v gh`.
2. Verify authentication for the selected host with the installed `gh auth status` syntax.
3. If exact flags or host syntax are uncertain, run `gh auth status --help` or the relevant subcommand `--help` and use the installed version's interface.

Do not perform login automatically. If auth is missing or invalid, show the original CLI output and stop.

## Inspect

Use `gh pr view`/`gh pr list` with an explicit repository when possible.

For an existing PR, read at least:

- identifier/URL;
- state;
- source branch;
- target branch;
- title;
- body when an update is requested.

## Create

Before creation:

1. Verify the source branch already exists remotely. Do not push it here.
2. Search for an open PR for the same source branch and target branch/repository.
3. If one exists, report it and stop.

Use `gh pr create` with explicit repository, base, head, title, and body. Prefer a body file or other quoting-safe mechanism supported by the installed CLI. Do not rely on an interactive flow that may offer to push or fork a branch.

After creation, read or capture the PR URL and return it.

## Update

Only update when the user explicitly asked to update an existing PR.

1. Read the current PR title/body first.
2. Determine which fields the user asked to change.
3. Preserve all other fields and useful manual content.
4. Use `gh pr edit` only for the requested fields.

If a newly generated body would discard unrelated manual sections and the user did not explicitly request full replacement, do not overwrite it silently.

## Failures

Treat `gh` as the authority for its own errors. Preserve its exit status and output. Do not classify failures by matching human-readable error text.
