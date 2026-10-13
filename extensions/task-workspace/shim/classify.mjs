/**
 * task-workspace — shared git invocation classification (plain ESM).
 *
 * Single source of truth for the subcommand/flag classification tables and
 * rules. Consumers:
 *   - shim/policy.mjs — the runtime policy consulted by the PATH shim
 *     (runs under node or bun, whatever pi's process.execPath is);
 *   - guard.ts — thin typed re-exports for TypeScript consumers.
 *
 * The input is REAL ARGV (post-shell, unquoted) plus the resolved working
 * directory — there is no shell string anywhere in this module, and no
 * Bash parsing anywhere in agent-kit. The tables below are migrated
 * byte-identical from the former shell-lexer guard: they are
 * battle-tested and must not be "cleaned up" casually.
 */

/** git flags that consume the next token as their value. */
export const GIT_VALUE_FLAGS = {
  "-C": true,
  "-c": true,
  "--git-dir": true,
  "--work-tree": true,
  "--namespace": true,
  "--super-prefix": true,
};

/**
 * Subcommands that pass regardless of their arguments. Only subcommands
 * with NO mutating mode belong here (no write/delete flag, no option that
 * runs an arbitrary program); anything else stays unlisted and falls into
 * `ambiguous` (fail closed). `grep` is deliberately absent: its
 * `-O/--open-files-in-pager` runs an arbitrary command.
 */
export const READ_ONLY_GIT_SUBCOMMANDS = {
  blame: true,
  "cat-file": true,
  "check-attr": true,
  "check-ignore": true,
  describe: true,
  diff: true,
  "for-each-ref": true,
  log: true,
  "ls-files": true,
  "ls-tree": true,
  "merge-base": true,
  "name-rev": true,
  "rev-list": true,
  "rev-parse": true,
  shortlog: true,
  show: true,
  "show-ref": true,
  status: true,
};

export const LOCAL_MUTATION_GIT_SUBCOMMANDS = {
  add: true,
  checkout: true,
  "cherry-pick": true,
  clean: true,
  commit: true,
  merge: true,
  rebase: true,
  reset: true,
  restore: true,
  switch: true,
};

export const BRANCH_READ_ONLY_FLAGS = {
  "--all": true,
  "--contains": true,
  "--format": true,
  "--list": true,
  "--merged": true,
  "--no-merged": true,
  "--points-at": true,
  "--remotes": true,
  "--show-current": true,
  "--sort": true,
  "--verbose": true,
  "--column": true,
  "-a": true,
  "-l": true,
  "-r": true,
  "-v": true,
  "-vv": true,
  "-n": true,
};

export const BRANCH_MUTATION_FLAGS = {
  "--copy": true,
  "--delete": true,
  "--edit-description": true,
  "--move": true,
  "--set-upstream-to": true,
  "--track": true,
  "--unset-upstream": true,
  "-c": true,
  "-C": true,
  "-d": true,
  "-D": true,
  "-f": true,
  "-m": true,
  "-M": true,
  "-u": true,
};

export const TAG_READ_ONLY_FLAGS = {
  "--contains": true,
  "--format": true,
  "--list": true,
  "--merged": true,
  "--no-merged": true,
  "--points-at": true,
  "--sort": true,
  "--column": true,
  "--verify": true,
  "-l": true,
  "-n": true,
  "-v": true,
};

export const TAG_MUTATION_FLAGS = {
  "--annotate": true,
  "--create-reflog": true,
  "--delete": true,
  "--force": true,
  "--local-user": true,
  "--message": true,
  "--sign": true,
  "--cleanup": true,
  "-a": true,
  "-d": true,
  "-f": true,
  "-m": true,
  "-s": true,
};
export const READ_ONLY_VALUE_FLAGS = {
  "--contains": true,
  "--format": true,
  "--merged": true,
  "--no-merged": true,
  "--points-at": true,
  "--sort": true,
  "-n": true,
};

export function unquoteToken(token) {
  if (
    token.length >= 2 &&
    ((token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'")))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

export function flagName(token) {
  return unquoteToken(token).split("=", 1)[0];
}
export function consumesSeparateValue(token, flag) {
  return READ_ONLY_VALUE_FLAGS[flag] === true && !token.includes("=");
}

export function classifyBranchOperation(rest) {
  let readMode = false;
  for (let i = 0; i < rest.length; i++) {
    const token = unquoteToken(rest[i]);
    const flag = flagName(token);
    if (BRANCH_MUTATION_FLAGS[flag] === true || flag === "--force") {
      return "local/ref-mutation";
    }
    if (BRANCH_READ_ONLY_FLAGS[flag] === true) {
      readMode = true;
      if (consumesSeparateValue(token, flag)) i++;
      continue;
    }
    if (token.startsWith("-")) return "ambiguous";
    if (!readMode) return "local/ref-mutation";
  }
  return "read-only";
}

export function classifyTagOperation(rest) {
  let readMode = false;
  for (let i = 0; i < rest.length; i++) {
    const token = unquoteToken(rest[i]);
    const flag = flagName(token);
    if (TAG_MUTATION_FLAGS[flag] === true) return "local/ref-mutation";
    if (TAG_READ_ONLY_FLAGS[flag] === true) {
      readMode = true;
      if (consumesSeparateValue(token, flag)) i++;
      continue;
    }
    if (token.startsWith("-")) return "ambiguous";
    if (!readMode) return "local/ref-mutation";
  }
  return "read-only";
}

export function classifyRemoteOperation(rest) {
  const first = rest[0] ? unquoteToken(rest[0]) : "";
  if (
    first === "" ||
    first === "-v" ||
    first === "--verbose" ||
    first === "get-url" ||
    first === "get-branches" ||
    first === "show"
  ) {
    return "read-only";
  }
  return "local/ref-mutation";
}
export const FETCH_VALUE_FLAGS = {
  "--depth": true,
  "--filter": true,
  "--negotiation-tip": true,
  "--server-option": true,
  "--shallow-exclude": true,
  "--shallow-since": true,
  "--upload-pack": true,
};

export function classifyFetchRefspec(refspec) {
  const separator = refspec.indexOf(":");
  if (separator === -1) return "ambiguous";
  const destination = refspec.slice(separator + 1);
  return destination.startsWith("refs/heads/")
    ? "local/ref-mutation"
    : "ambiguous";
}

export function classifyFetchOperation(rest) {
  for (let i = 0; i < rest.length; i++) {
    const token = unquoteToken(rest[i]);
    const flag = flagName(token);
    if (flag === "--stdin") return "ambiguous";
    if (flag === "-P" || flag === "--prune-tags") {
      return "local/ref-mutation";
    }
    if (flag === "--refmap") {
      const refspec = token.includes("=")
        ? token.slice(token.indexOf("=") + 1)
        : rest[++i];
      if (refspec === undefined) return "ambiguous";
      return classifyFetchRefspec(unquoteToken(refspec));
    }
    if (token.startsWith("-")) {
      if (
        FETCH_VALUE_FLAGS[flag] === true &&
        !token.includes("=")
      ) {
        i++;
      }
      continue;
    }

    if (token.includes(":")) return classifyFetchRefspec(token);
  }
  return "safe-refresh";
}

/**
 * Split the leading git global flags off a real argv (everything after the
 * `git` command word). Returns the `-C` chain in order of appearance (for
 * left-to-right repo-dir resolution), whether `--git-dir`/`--work-tree`
 * were present (either `--flag value` or `--flag=value`), and the remaining
 * tokens starting at the subcommand. The consumption loop is the migrated
 * rule from the former guard: ambiguous shapes stay ambiguous and the
 * caller fails closed.
 */
export function splitGitGlobalArgs(argv) {
  const chain = [];
  let hasGitDir = false;
  let hasWorkTree = false;
  let i = 0;
  while (i < argv.length && argv[i].startsWith("-") && argv[i] !== "-") {
    const flag = argv[i];
    if (flag.includes("=")) {
      if (flagName(flag) === "--git-dir") hasGitDir = true;
      if (flagName(flag) === "--work-tree") hasWorkTree = true;
      i++;
      continue;
    }
    if (GIT_VALUE_FLAGS[flag] === true) {
      const value = argv[i + 1];
      if (value === undefined) break;
      if (flag === "-C") chain.push(value);
      if (flag === "--git-dir") hasGitDir = true;
      if (flag === "--work-tree") hasWorkTree = true;
      i += 2;
      continue;
    }
    i++;
  }
  return { chain, hasGitDir, hasWorkTree, rest: argv.slice(i) };
}

/**
 * Classify the subcommand + argument tokens of one git invocation (the
 * argv after global-flag consumption). Migrated verdict rule: read-only
 * and safe-refresh pass; push is an external side effect handled by the
 * caller; everything else (local/ref-mutation, ambiguous) is mutating —
 * fail closed on ambiguity.
 */
export function classifyInvocationTokens(subcommand, rest) {
  let operationClass;
  if (subcommand === "branch") {
    operationClass = classifyBranchOperation(rest);
  } else if (subcommand === "tag") {
    operationClass = classifyTagOperation(rest);
  } else if (subcommand === "worktree") {
    const first = rest[0] ? flagName(rest[0]) : "";
    operationClass =
      first === "list" || first === "show" ? "read-only" : "local/ref-mutation";
  } else if (subcommand === "fetch") {
    operationClass = classifyFetchOperation(rest);
  } else if (subcommand === "push") {
    operationClass = "external-side-effect";
  } else if (subcommand === "update-ref") {
    operationClass = "local/ref-mutation";
  } else if (subcommand === "remote") {
    operationClass = classifyRemoteOperation(rest);
  } else if (READ_ONLY_GIT_SUBCOMMANDS[subcommand] === true) {
    operationClass = "read-only";
  } else if (LOCAL_MUTATION_GIT_SUBCOMMANDS[subcommand] === true) {
    operationClass = "local/ref-mutation";
  } else {
    operationClass = "ambiguous";
  }
  const mutating =
    operationClass === "local/ref-mutation" ||
    operationClass === "ambiguous";
  const noVerify =
    rest.some((t) => unquoteToken(t) === "--no-verify") ||
    (subcommand === "commit" && rest.some((t) => unquoteToken(t) === "-n"));
  return { subcommand, operationClass, mutating, noVerify };
}
