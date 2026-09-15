---
name: atlassian
description: "Work with Jira and Confluence through the local CLI tools. Use for Jira issues, sprints, JQL searches, and Confluence search/read operations."
---

Use the local CLI tools through `bash`. Do not use Atlassian MCP.

## Jira

Use `jira` (ankitpokhrel/jira-cli) against `https://jira.cloud.ru`.

For issue searches, generate JQL directly from the user's request. Prefer
machine-readable output when the result will be consumed by the model:

    jira issue list --jql '<JQL>' --raw

Conventions:

- use `currentUser()` instead of guessing the user's Jira username;
- use `statusCategory != Done` for "open/not completed" unless specific statuses are requested;
- use `sprint in openSprints()` for the current active sprint;
- let Jira perform filtering and ordering instead of fetching broad result sets and filtering them manually;
- results are scoped to the configured default project (`EVODP`); pass `-p <PROJECT>` to search elsewhere.

Put ordering in the `--order-by` flag, never inside `--jql`. The CLI always
appends its own `ORDER BY <order-by> <direction>` to the query, so an `ORDER BY`
clause embedded in `--jql` produces an invalid query and the server rejects it
with a 400 JQL parse error. Direction defaults to DESC:

    jira issue list --jql 'assignee = currentUser() AND sprint in openSprints() AND statusCategory != Done' --order-by priority --raw

Use dedicated sprint commands when they are simpler than JQL; sprint commands
need an explicit board (`--board <name>` or `-B`).

If syntax is uncertain, inspect `jira --help` or the relevant subcommand help.

## Confluence

Use `confluence` (pchuri/confluence-cli) against `https://wiki.cloud.ru`.
Configuration comes from the environment (`CONFLUENCE_*` variables set in
`~/.zshenv`); there is no config profile on this machine. The instance is
self-hosted, so the API path is `/rest/api`.

Typical flow:

    confluence search "<query>" --json
    confluence read <page-id-or-url> --format markdown

Useful metadata and hierarchy commands:

    confluence info <page-id-or-url> --json
    confluence children <page-id> --json
    confluence comments <page-id> --json
    confluence find "<title>"

Search first, then read only relevant pages instead of loading many pages
unnecessarily.

Confluence access is read-only by default (`CONFLUENCE_READ_ONLY=true`; write
commands fail with a read-only error). Do not modify Confluence content unless
the user explicitly requests it, and never by removing that flag.

If syntax is uncertain, inspect `confluence --help` or the relevant subcommand
help. `--json` is a global flag for machine-readable output.

## General

Authentication uses personal access tokens from the existing environment
(`JIRA_PERSONAL_TOKEN`, `CONFLUENCE_PERSONAL_TOKEN`, mapped to
`JIRA_API_TOKEN` / `CONFLUENCE_API_TOKEN` in `~/.zshenv`). Never print, copy,
or store token values.

Report actual CLI/API errors. Do not silently weaken or simplify a valid query
until something happens to work.

Do not introduce a custom wrapper around these CLIs unless the installed tools
demonstrably cannot support the required operation.
