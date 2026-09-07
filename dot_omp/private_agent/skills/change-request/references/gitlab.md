# GitLab with glab

Use this reference only after GitLab is the selected publication target.

## Target resolution

Require the GitLab host and repository/project to be explicit before publication. Support gitlab.com, personal/self-hosted GitLab, and corporate GitLab instances equally. Never bake a specific organization hostname into the skill.

If the target is ambiguous, inspect read-only remotes only to present candidates. Let the user choose.

## Minimal preflight

1. Verify `glab` exists with `command -v glab`.
2. Verify authentication for the selected host using the installed `glab auth status` syntax.
3. If exact flags or host syntax are uncertain, run `glab auth status --help` or the relevant subcommand `--help` and use the installed version's interface.

Do not perform login automatically. If auth is missing or invalid, show the original CLI output and stop.

## Inspect

Use `glab mr view`/`glab mr list` with an explicit repository/project and host context when supported by the installed version.

For an existing MR, read at least:

- identifier/URL;
- state;
- source branch;
- target branch;
- title;
- description when an update is requested.

## Create

Before creation:

1. Verify the source branch already exists remotely. Do not push it here.
2. Search for an open MR for the same source branch and target branch/project.
3. If one exists, report it and stop.

Use `glab mr create` non-interactively with explicit project/repository, source branch, target branch, title, and description using flags supported by the installed version. Prefer a file-based description option when available; otherwise use a quoting-safe invocation.

Do not rely on interactive behavior that performs git mutation.

After creation, read or capture the MR URL and return it.

## Update

Only update when the user explicitly asked to update an existing MR.

1. Read the current MR title/description first.
2. Determine which fields the user asked to change.
3. Preserve all other fields and useful manual content.
4. Use the installed `glab mr update`/edit equivalent only for the requested fields. Check `glab mr --help` if the command name differs in the installed version.

If a newly generated description would discard unrelated manual sections and the user did not explicitly request full replacement, do not overwrite it silently.

## Failures

Treat `glab` as the authority for its own errors. Preserve its exit status and output. Do not classify failures by matching human-readable error text.
