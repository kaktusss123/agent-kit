# 10-dotsync.zsh — OMP/cmux dotfiles sync helpers.
# Managed by chezmoi (source: ~/projects/dotfiles/dot_zshrc.d/10-dotsync.zsh).
# Commands: dots-status, dots-pull, dots-push (aliases: dstatus, dpull, dpush).

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

# dots-status — read-only overview of the sync state. Never mutates anything.
dots-status() {
  local repo machine branch dirty untracked upstream counts behind ahead changed
  repo="$(_dots_repo)" || { echo "dots-status: cannot locate chezmoi source directory" >&2; return 1; }
  machine="$(_dots_machine)"
  echo "Machine: ${machine:-unknown}"
  echo "Repo: $repo"
  if [[ ! -d "$repo/.git" ]]; then
    echo "dots-status: $repo is not a git repository" >&2
    return 1
  fi
  branch="$(git -C "$repo" branch --show-current 2>/dev/null)"
  echo "Branch: ${branch:-detached}"
  dirty="$(git -C "$repo" status --porcelain 2>/dev/null | grep -vc '^??')"
  if (( dirty > 0 )); then
    echo "Local changes: yes ($dirty tracked file(s))"
  else
    echo "Local changes: none"
  fi
  untracked="$(git -C "$repo" ls-files --others --exclude-standard 2>/dev/null | wc -l | tr -d ' ')"
  (( untracked > 0 )) && echo "Untracked in repo: $untracked (never auto-committed)"
  upstream="$(git -C "$repo" rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null)"
  if [[ -n "$upstream" ]]; then
    counts="$(git -C "$repo" rev-list --left-right --count "$upstream"...HEAD 2>/dev/null)"
    behind="${counts%%$'\t'*}"
    ahead="${counts##*$'\t'}"
    echo "Remote ($upstream): ahead $ahead / behind $behind"
  else
    echo "Remote: no upstream configured"
  fi
  changed="$(chezmoi status 2>/dev/null)"
  if [[ -n "$changed" ]]; then
    echo
    echo "Changed managed files:"
    echo "$changed"
  fi
}

# dots-pull — fetch the latest dotfiles and apply them safely.
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
  if (( ahead == 0 && behind == 0 )); then
    echo "Already up to date."
    return 0
  fi
  if (( ahead > 0 )); then
    echo "dots-pull: local is $ahead commit(s) ahead of $upstream — run 'dots-push' first" >&2
    return 1
  fi
  echo "Pulling $behind commit(s):"
  git -C "$repo" log --oneline --no-decorate "HEAD..$upstream"
  git -C "$repo" pull --ff-only --quiet origin || {
    echo "dots-pull: fast-forward pull failed (history diverged?)" >&2
    return 1
  }
  echo
  echo "Changes to apply:"
  chezmoi diff
  chezmoi apply || { echo "dots-pull: chezmoi apply failed" >&2; return 1; }
  echo
  dots-status
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

# dots-push — capture managed-file changes, scan for secrets, commit, push.
dots-push() {
  local repo msg before upstream counts behind offending untracked
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
  before="$(chezmoi status 2>/dev/null)"
  if [[ -z "$before" ]]; then
    echo "Nothing to push (no managed file changes)."
    return 0
  fi
  if git -C "$repo" remote | grep -q .; then
    git -C "$repo" fetch --quiet origin 2>/dev/null || true
    upstream="$(git -C "$repo" rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null)"
    if [[ -n "$upstream" ]]; then
      counts="$(git -C "$repo" rev-list --left-right --count "$upstream"...HEAD 2>/dev/null)"
      behind="${counts%%$'\t'*}"
      if (( behind > 0 )); then
        echo "dots-push: remote has $behind unpulled commit(s) — run 'dots-pull' first" >&2
        return 1
      fi
    fi
  fi
  if ! chezmoi re-add >/dev/null 2>&1; then
    echo "dots-push: 'chezmoi re-add' failed" >&2
    return 1
  fi
  git -C "$repo" add -u || { echo "dots-push: git add failed" >&2; return 1; }
  if git -C "$repo" diff --cached --quiet; then
    echo "Nothing to push (no source changes after re-add)."
    return 0
  fi
  if offending="$(dots_secret_scan "$repo")"; then
    :
  else
    echo "Refusing to commit:"
    echo "$offending"
    echo "dots-push: secret scan failed — fix the file(s) above, then retry" >&2
    git -C "$repo" reset -q
    return 1
  fi
  untracked="$(git -C "$repo" ls-files --others --exclude-standard)"
  if [[ -n "$untracked" ]]; then
    echo "Note: untracked files in the repo are NOT committed:"
    echo "$untracked" | sed 's/^/  /'
  fi
  echo "Committing:"
  git -C "$repo" status --short
  git -C "$repo" commit -q -m "$msg" || { echo "dots-push: commit failed" >&2; return 1; }
  echo "Committed: $msg"
  if git -C "$repo" remote | grep -q .; then
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

alias dstatus='dots-status'
alias dpull='dots-pull'
alias dpush='dots-push'
