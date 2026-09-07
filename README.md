# dotfiles — OMP + cmux portable configuration

Private, git-based sync of portable Oh My Pi and cmux configuration between a
personal Mac (dev machine) and a work Mac (dogfooding machine), driven by
[chezmoi](https://www.chezmoi.io/).

```
private Git repository  (github.com:kaktusss123/omp-cmux-dotfiles)
        └── chezmoi
              ├── personal Mac   (machineType = "personal")
              └── work Mac       (machineType = "work")
```

## Architecture

- One repository, one branch (`main`). Machine differences are a *local*
  chezmoi data variable — no branches, no per-machine repos.
- `~/.omp/agent` and `~/.config/cmux` keep their normal runtime locations.
  OMP is **not** pointed at the Git repo as its state directory.
- Synchronization is explicit: `dots-push` here, `dots-pull` there. No
  daemons, watchers, cron, or auto-commit.

## Managed files

| Destination | Source |
|---|---|
| `~/.omp/agent/config.yml` | `dot_omp/private_agent/private_config.yml` |
| `~/.omp/agent/mcp.json` | `dot_omp/private_agent/private_mcp.json` |
| `~/.omp/agent/extensions/*` | `dot_omp/private_agent/extensions/*` |
| `~/.omp/agent/skills/*` | `dot_omp/private_agent/skills/*` |
| `~/.omp/agent/prompts/*` | `dot_omp/private_agent/prompts/*` |
| `~/.omp/agent/managed-skills/*` | `dot_omp/private_agent/managed-skills/*` |
| `~/.config/cmux/cmux.json` | `private_dot_config/cmux/private_cmux.json` |
| `~/.zshrc.d/10-dotsync.zsh` | `dot_zshrc.d/10-dotsync.zsh` |

The `private_` prefixes tell chezmoi to keep restrictive modes
(`~/.omp/agent` stays 0700, `cmux.json` stays 0600).

Only files that exist on the machine are managed. `models.yml` does not
exist yet on either machine; when it is added it should be adopted with
`chezmoi add`.

cmux note: `cmux.json` is cmux's file-managed settings location. It is
currently cmux's generated template (every setting commented out), so no
personalization is portable yet — the real settings
(e.g. `appLanguage: ru`) live in the machine-local
`~/Library/Preferences/com.cmuxterm.app.plist`, which is never synced
(it mixes user settings with auth identifiers and UI state). To make a
setting portable, uncomment it in `cmux.json` and `dots-push`.

## Intentionally unmanaged (runtime / machine state)

- `~/.omp/agent/sessions/`, `memories/`, `terminal-sessions/`, `cache/`
- `~/.omp/agent/*.db*` (`agent.db`, `history.db`, `models.db`), `*.lock`
- `~/.omp/{logs,cache,plugins,run,tasks}`, `install-id`, `gpu_cache.json`
- `~/.omp/agent/config.yml.lock`, `mcp.json.lock`
- cmux: `~/Library/Application Support/cmux/*` (sessions, search.db,
  notification/closed-item history, last-socket-path) and
  `~/Library/Preferences/com.cmuxterm.app.plist` (machine-local settings,
  auth identifiers, UI state)
- `~/.zshrc` — contains machine-local env/credentials; **never** managed
- `.DS_Store` and other macOS metadata

Rule of thumb: if a file is written by the app at runtime (db, log, cache,
session, lock, history, auth), it stays local. If you are unsure, leave it
out.

## Secret policy

- No API keys, tokens, passwords, or OAuth state in this repo — ever.
- Configs reference environment variables when OMP supports it
  (e.g. `apiKey: "{env:CLOUDRU_API_KEY}"`). Values stay machine-local.
- `dots-push` runs a lightweight secret scan over the staged diff
  (`sk-`, `Bearer`, `AKIA…`, `ghp_…`, private-key headers, and
  `apiKey`/`token`/`password`/… followed by literal values) and refuses to
  commit when something matches, reporting only file:line.
- `~/.zshrc` currently holds plaintext credentials
  (`CLOUDRU_API_KEY`, `OPENROUTER_API_KEY`, `CONFLUENCE_PERSONAL_TOKEN`,
  `JIRA_PERSONAL_TOKEN`, `KANBAN_DB_PASSWORD`). This file is **not** managed
  and must never be added. Consider moving these to a secret manager
  (e.g. macOS Keychain / `security` integration) and rotating them — they
  were visible during inspection.
- Machine-local API keys still need to be set on each Mac (shell env or
  OMP credential store); they are not part of the repo.

## Personal vs work

`machineType` lives in each machine's local config
`~/.config/chezmoi/chezmoi.toml` (not in the repo):

```toml
sourceDir = "~/projects/dotfiles"
[data]
machineType = "personal"   # or "work"
```

Currently all managed configs are fully portable, so no templates are
needed. When a real difference appears, use a template
(e.g. `dot_omp/private_agent/private_config.yml.tmpl` with
`{{ if eq .machineType "personal" }}…`). Do not add templating for
differences that do not exist.

Development checkouts (`~/projects/my-pi`, `~/projects/oh-my-skills`, …)
are separate from the dotfiles repo. If config ever references dev paths,
make those references personal-machine-specific (via `machineType`).

## Bootstrap (second Mac)

```bash
brew install chezmoi
git clone git@github.com:kaktusss123/omp-cmux-dotfiles.git ~/projects/dotfiles
mkdir -p ~/.config/chezmoi
cat > ~/.config/chezmoi/chezmoi.toml <<'EOF'
sourceDir = "~/projects/dotfiles"
[data]
machineType = "work"
EOF
chezmoi apply
# one-time shell wiring (append to ~/.zshrc):
[[ -f "$HOME/.zshrc.d/10-dotsync.zsh" ]] && source "$HOME/.zshrc.d/10-dotsync.zsh"
```

Then set machine-local API keys (shell env or OMP credential store) and
authenticate the Mac to GitHub (SSH key) if not already done.

Note: `chezmoi apply` also enforces the recorded directory modes, so
`~/.config` becomes 0700 and `~/.config/cmux/cmux.json` 0600, matching the
personal Mac — same-user and safe, but a visible change if your work Mac
`~/.config` was 0755.

## Normal workflow

```bash
dots-status   # all three legs: git vs origin, repo vs home, per-file next actions
dots-pull     # origin → repo (ff-only) → chezmoi apply to home (always applies, even when git is up to date)
dots-push     # home → repo (re-add + adopted files) → secret scan → commit → rebase → push
dots-sync     # both directions in one command
```

Short aliases: `dstatus`, `dpull`, `dpush`, `dsync`.

`dots-pull` never destroys work: it refuses when the source repo has
uncommitted changes (run `dots-push` first) and is fast-forward only.
It always syncs home to the repo afterwards (`chezmoi apply`) — "already
up to date" in git does not mean the home files are applied.

`dots-push` never adopts unmanaged home files implicitly (run `chezmoi add`
first); files you have adopted are staged and committed automatically. When
the remote is ahead it rebases local commits onto it instead of refusing —
only real rebase conflicts need manual work. Optional commit message:
`dots-push "tune OMP model profiles"`.

## Recovery from conflicts

- Diverged history (local and remote both have commits — the only case
  pull refuses):
  `dots-push` rebases onto origin automatically; if it reports rebase
  conflicts, resolve them with standard git commands, then run
  `dots-push` again.
- Unmerged paths: resolve with standard git commands
  (`git status` lists them), then `git add` + `chezmoi apply`.
- A secret slipped into a commit: remove it from the file, commit the fix,
  and rotate the credential. Contact GitHub support about purging history
  if it was pushed (or rewrite history only if the repo is private and
  uncontested).

## Adding a new managed config file

```bash
chezmoi add ~/.omp/agent/models.yml     # adopts it into the repo
dots-status                             # confirm it appears
dots-push "add models.yml"              # commit + push
```

Keep machine-specific bits out of the file; if a value differs per machine,
template it with `machineType` (see above).

## Inspecting changes before applying

```bash
chezmoi diff        # destination vs source (dry run)
chezmoi apply --dry-run --verbose
dots-status         # changed managed files + git state
```
