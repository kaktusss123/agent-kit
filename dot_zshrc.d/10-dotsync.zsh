# 10-dotsync.zsh — OMP/cmux dotfiles sync helpers.
# Managed by chezmoi (source: ~/projects/dotfiles/dot_zshrc.d/10-dotsync.zsh).
# Commands: dots-status, dots-pull, dots-push, dots-sync
# Aliases:  dstatus, dpull, dpush, dsync
#
# The state has three legs:
#   home (target files) <-> repo (chezmoi source) <-> origin (GitHub).
# Git being up to date does NOT mean the home files are applied — apply is a
# separate step. dots-pull therefore always runs chezmoi apply; dots-sync
# makes all three legs consistent in one command.

_dots_repo() {
  chezmoi source-path 2>/dev/null
}

_dots_machine() {
  chezmoi execute-template '{{ .machineType }}' 2>/dev/null
}

_dots_git_unfinished() {
  local repo="$1"
  [[ -e "$repo/.git/MERGE_HEAD" || -d "$repo/.git/rebase-merge" || -d "$repo/.git/rebase-apply" ]]
}

# dots_secret_scan — lightweight scan of the staged diff for likely secrets.
# Prints only file:line references, never matched values. Exit 0 = clean.
# Key/value patterns are matched case-insensitively (apiKey, API_KEY, ...).
dots_secret_scan() {
  local repo="$1"
  git -C "$repo" diff --cached | awk '
    BEGIN { file = ""; line = 0; found = 0 }
    /^\+\+\+ b\// { file = substr($0, 7); sub(/^b\//, "", file); line = 0; next }
    /^@@/ { line = 0; next }
    /^\+/ && !/^\+\+\+/ {
      line++
      l = $0
      k = tolower(l)
      label = ""
      if (l ~ /-----BEGIN [A-Z ]*PRIVATE KEY-----/) label = "private key"
      else if (k ~ /bearer[[:space:]]+[a-z0-9._-]{8,}/) label = "Bearer token"
      else if (l ~ /(^|[^A-Za-z0-9])sk-[A-Za-z0-9][A-Za-z0-9-]{7,}/) label = "API token (sk-...)"
      else if (l ~ /AKIA[0-9A-Z]{16}/) label = "AWS access key"
      else if (l ~ /gh[pous]_[A-Za-z0-9]{6,}/) label = "GitHub token"
      else if (k ~ /(api[_-]?key|client[_-]?secret|secret|token|password|authorization|bearer|oauth)[[:space:]]*[:=][[:space:]]*["'"'"']?[a-z0-9_@.\/-]{8,}["'"'"']?/) {
        if (k !~ /(\{[^}]*\}|<[^>]*>|\$[a-z_][a-z0-9_]*|changeme|example|your[_-]?(key|token|secret)|xxxx+)/) label = "credential"
      }
      if (label != "") { printf "  %s in %s:%d\n", label, file, line; found = 1 }
    }
    END { exit found ? 1 : 0 }
  '
}

# dots-status — read-only overview of all three legs. Never mutates anything.
dots-status() {
  local repo machine branch upstream counts behind ahead dirty untracked changed total gitline
  repo="$(_dots_repo)" || { echo "dots-status: cannot locate chezmoi source directory" >&2; return 1; }
  machine="$(_dots_machine)"
  echo "Machine: ${machine:-unknown}"
  if [[ ! -d "$repo/.git" ]]; then
    echo "dots-status: $repo is not a git repository" >&2
    return 1
  fi
  echo "Repo:    $repo"
  branch="$(git -C "$repo" branch --show-current 2>/dev/null)"
  upstream="$(git -C "$repo" rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null)"
  gitline="branch ${branch:-detached}"
  if [[ -n "$upstream" ]]; then
    counts="$(git -C "$repo" rev-list --left-right --count "$upstream"...HEAD 2>/dev/null)"
    behind="${counts%%$'\t'*}"
    ahead="${counts##*$'\t'}"
    if (( ahead == 0 && behind == 0 )); then
      gitline+=", in sync with $upstream (as of last fetch)"
    else
      gitline+=", ahead $ahead / behind $behind of $upstream (as of last fetch)"
    fi
  else
    gitline+=", no upstream configured"
  fi
  dirty="$(git -C "$repo" status --porcelain 2>/dev/null | grep -vc '^??')"
  (( dirty > 0 )) && gitline+=", $dirty uncommitted tracked file(s)"
  untracked="$(git -C "$repo" ls-files --others --exclude-standard 2>/dev/null | wc -l | tr -d ' ')"
  (( untracked > 0 )) && gitline+=", $untracked untracked"
  echo "Git:     $gitline"

  changed="$(chezmoi status 2>/dev/null)"
  if [[ -z "$changed" ]]; then
    echo "chezmoi: repo and home in sync"
    return 0
  fi
  total="$(printf '%s\n' "$changed" | wc -l | tr -d ' ')"
  echo "chezmoi: $total difference(s) between repo and home:"
  printf '%s\n' "$changed" | while IFS= read -r line; do
    local st="${line%% *}" target_path="${line#* }"
    echo "  $target_path"
    case "$st" in
      A) echo "      only in repo, not applied to home — 'dots-pull' fixes this" ;;
      M) echo "      differs from home — 'dots-push' takes home's version, 'dots-pull' takes repo's" ;;
      D) echo "      deletion pending — applied by 'dots-pull'" ;;
      *) echo "      state $st" ;;
    esac
  done
  echo "Hint: 'dots-sync' publishes and applies in one command."
}

# dots-pull — bring origin changes into the repo, then apply them to home.
# Always runs chezmoi apply when there is anything to apply, even when git is
# already up to date: git sync and home apply are independent steps.
# Safety: refuses on uncommitted tracked changes (run 'dots-push' first) and
# on diverged history; fast-forward only. Local-only unpushed commits are
# applied to home and flagged for 'dots-push'.
dots-pull() {
  local repo upstream counts behind ahead tracked_dirty
  repo="$(_dots_repo)" || return 1
  if [[ ! -d "$repo/.git" ]]; then
    echo "dots-pull: $repo is not a git repository" >&2
    return 1
  fi
  if _dots_git_unfinished "$repo"; then
    echo "dots-pull: Git has an unresolved merge/rebase in $repo — resolve it first" >&2
    return 1
  fi
  tracked_dirty="$(git -C "$repo" status --porcelain 2>/dev/null | grep -vc '^??')"
  if (( tracked_dirty > 0 )); then
    echo "dots-pull: source repo has uncommitted changes — run 'dots-push' first" >&2
    return 1
  fi
  if ! git -C "$repo" remote | grep -q .; then
    echo "dots-pull: no git remote configured" >&2
    return 1
  fi
  git -C "$repo" fetch --quiet origin || { echo "dots-pull: git fetch failed" >&2; return 1; }
  upstream="$(git -C "$repo" rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null)"
  if [[ -z "$upstream" ]]; then
    echo "dots-pull: branch has no upstream — set it with: git branch --set-upstream-to=origin/main" >&2
    return 1
  fi
  counts="$(git -C "$repo" rev-list --left-right --count "$upstream"...HEAD 2>/dev/null)"
  behind="${counts%%$'\t'*}"
  ahead="${counts##*$'\t'}"
  if (( behind == 0 && ahead == 0 )); then
    echo "Git: already up to date with $upstream."
  elif (( behind == 0 )); then
    echo "Git: $ahead local commit(s) not pushed yet — 'dots-push' will publish them."
  elif (( ahead > 0 )); then
    echo "dots-pull: diverged from $upstream — local is $ahead commit(s) ahead and $behind behind — run 'dots-push' first (it rebases)" >&2
    return 1
  else
    echo "Pulling $behind commit(s):"
    git -C "$repo" log --oneline --no-decorate "HEAD..$upstream"
    git -C "$repo" pull --ff-only --quiet origin || {
      echo "dots-pull: fast-forward pull failed" >&2
      return 1
    }
  fi
  echo
  if [[ -z "$(chezmoi diff 2>/dev/null)" ]]; then
    echo "chezmoi: home already matches the repo."
  else
    echo "Applying repo changes to home:"
    chezmoi diff
    chezmoi apply || { echo "dots-pull: chezmoi apply failed" >&2; return 1; }
  fi
  echo
  dots-status
}

# dots-push — capture home changes into the repo, scan for secrets, commit,
# integrate with origin (rebase when behind), push.
#
# - Modified managed files are re-added from home automatically.
# - Files adopted with 'chezmoi add' (new in the repo) are staged
#   automatically; repo-meta files (README.md, .gitignore, .chezmoiignore)
#   are always staged manually.
# - Unmanaged home files are never adopted implicitly — run 'chezmoi add'.
dots-push() {
  local repo msg upstream counts ahead behind offending newfiles cz_status tracked_dirty
  repo="$(_dots_repo)" || return 1
  msg="${1:-sync dotfiles}"
  if [[ ! -d "$repo/.git" ]]; then
    echo "dots-push: $repo is not a git repository" >&2
    return 1
  fi
  if _dots_git_unfinished "$repo"; then
    echo "dots-push: Git has an unresolved merge/rebase in $repo — resolve it first" >&2
    return 1
  fi
  cz_status="$(chezmoi status 2>/dev/null)"
  tracked_dirty="$(git -C "$repo" status --porcelain 2>/dev/null | grep -vc '^??')"
  newfiles="$(git -C "$repo" ls-files --others --exclude-standard 2>/dev/null | grep -v -E '^(README\.md|\.gitignore|\.chezmoiignore)$')"
  upstream="$(git -C "$repo" rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null)"
  ahead=0
  if [[ -n "$upstream" ]]; then
    counts="$(git -C "$repo" rev-list --left-right --count "$upstream"...HEAD 2>/dev/null)"
    ahead="${counts##*$'\t'}"
  fi
  if [[ -z "$cz_status" && "$tracked_dirty" -eq 0 && -z "$newfiles" && "$ahead" -eq 0 ]]; then
    echo "Nothing to push (repo and home already match, nothing adopted)."
    return 0
  fi
  if [[ -n "$cz_status" ]] && ! chezmoi re-add; then
    echo "dots-push: 'chezmoi re-add' failed — a managed file was probably edited outside chezmoi; run 'chezmoi re-add' manually to see why" >&2
    return 1
  fi
  git -C "$repo" add -u || { echo "dots-push: git add failed" >&2; return 1; }
  if [[ -n "$newfiles" ]]; then
    echo "Staging newly adopted file(s):"
    printf '  %s\n' ${(f)newfiles}
    git -C "$repo" add -- ${(f)newfiles} || { echo "dots-push: git add failed" >&2; return 1; }
  fi
  if git -C "$repo" diff --cached --quiet; then
    if (( ahead == 0 )); then
      echo "Nothing to push (no repo changes to publish)."
      return 0
    fi
  else
    if offending="$(dots_secret_scan "$repo")"; then
      :
    else
      echo "Refusing to commit:"
      echo "$offending"
      echo "dots-push: secret scan failed — fix the file(s) above, then retry" >&2
      git -C "$repo" reset -q
      return 1
    fi
    echo "Committing:"
    git -C "$repo" status --short
    git -C "$repo" commit -q -m "$msg" || { echo "dots-push: commit failed" >&2; return 1; }
    echo "Committed: $msg"
  fi
  if git -C "$repo" remote | grep -q .; then
    git -C "$repo" fetch --quiet origin 2>/dev/null || true
    upstream="$(git -C "$repo" rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null)"
    if [[ -n "$upstream" ]]; then
      counts="$(git -C "$repo" rev-list --left-right --count "$upstream"...HEAD 2>/dev/null)"
      behind="${counts%%$'\t'*}"
      if (( behind > 0 )); then
        echo "Remote is $behind commit(s) ahead — rebasing onto it:"
        if ! git -C "$repo" rebase --quiet "$upstream"; then
          echo "dots-push: rebase hit conflicts — resolve them in $repo, run 'git rebase --continue', then 'dots-push' again" >&2
          return 1
        fi
      fi
    fi
    if git -C "$repo" push --quiet; then
      echo "Pushed to origin."
    else
      echo "dots-push: push failed (committed locally; fix and re-run 'dots-push')" >&2
      return 1
    fi
  else
    echo "No git remote configured — committed locally only."
  fi
}

# dots-sync — make all three legs consistent: publish home changes to origin
# (re-add + commit + rebase + push), then apply origin state to home.
dots-sync() {
  dots-push "$@" && dots-pull
}

alias dstatus='dots-status'
alias dpull='dots-pull'
alias dpush='dots-push'
alias dsync='dots-sync'
