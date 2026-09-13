/**
 * task-workspace core — git mutation classification and guard verdicts.
 *
 * Classifies every git invocation in a shell command (fail closed) and
 * produces host-neutral guard verdicts for write/edit targets and bash
 * commands. The host binding maps a verdict onto its own tool-call block.
 */
import { basename, join } from "node:path";
import {
  classifyPath,
  expandPath,
  findGitRoot,
  hasTemporaryShellCwd,
  isAllowedIgnoredPrimaryPath,
  isGitMetadataPath,
  isTemporaryPath,
  managedWorktreeHint,
  realpath,
} from "./git";
import type {
  GitOperationClass,
  GuardVerdict,
  ParsedGitInvocation,
  PathClassification,
} from "./types";


/** git flags that consume the next token as their value. */
const GIT_VALUE_FLAGS: Record<string, true> = {
  "-C": true,
  "-c": true,
  "--git-dir": true,
  "--work-tree": true,
  "--namespace": true,
  "--super-prefix": true,
};

const READ_ONLY_GIT_SUBCOMMANDS: Record<string, true> = {
  "cat-file": true,
  describe: true,
  diff: true,
  "for-each-ref": true,
  log: true,
  "ls-files": true,
  "ls-tree": true,
  "rev-parse": true,
  show: true,
  "show-ref": true,
  status: true,
};

const LOCAL_MUTATION_GIT_SUBCOMMANDS: Record<string, true> = {
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

const BRANCH_READ_ONLY_FLAGS: Record<string, true> = {
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

const BRANCH_MUTATION_FLAGS: Record<string, true> = {
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

const TAG_READ_ONLY_FLAGS: Record<string, true> = {
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

const TAG_MUTATION_FLAGS: Record<string, true> = {
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
const READ_ONLY_VALUE_FLAGS: Record<string, true> = {
  "--contains": true,
  "--format": true,
  "--merged": true,
  "--no-merged": true,
  "--points-at": true,
  "--sort": true,
  "-n": true,
};


function unquoteToken(token: string): string {
  if (
    token.length >= 2 &&
    ((token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'")))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

function flagName(token: string): string {
  return unquoteToken(token).split("=", 1)[0];
}
function consumesSeparateValue(token: string, flag: string): boolean {
  return READ_ONLY_VALUE_FLAGS[flag] === true && !token.includes("=");
}

function classifyBranchOperation(rest: string[]): GitOperationClass {
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

function classifyTagOperation(rest: string[]): GitOperationClass {
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

function classifyRemoteOperation(rest: string[]): GitOperationClass {
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
const FETCH_VALUE_FLAGS: Record<string, true> = {
  "--depth": true,
  "--filter": true,
  "--negotiation-tip": true,
  "--server-option": true,
  "--shallow-exclude": true,
  "--shallow-since": true,
  "--upload-pack": true,
};

function classifyFetchRefspec(refspec: string): GitOperationClass {
  const separator = refspec.indexOf(":");
  if (separator === -1) return "ambiguous";
  const destination = refspec.slice(separator + 1);
  return destination.startsWith("refs/heads/")
    ? "local/ref-mutation"
    : "ambiguous";
}

function classifyFetchOperation(rest: string[]): GitOperationClass {
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

/** Conservative scan of EVERY `git` invocation in a (possibly compound) shell
 * command. It is not a shell interpreter: ambiguous input errs toward
 * local/ref-mutation so the guard fails closed. */
export function parseGitInvocations(command: string): ParsedGitInvocation[] {
  const invocations: ParsedGitInvocation[] = [];
  const gitWord = /(^|[\s;&|(`])git(?=$|[\s;&|(`])/g;
  let m: RegExpExecArray | null;

  while ((m = gitWord.exec(command)) !== null) {
    const tokens: string[] = [];
    let i = m.index + m[0].length;
    while (i < command.length) {
      while (i < command.length && /\s/.test(command[i])) i++;
      if (i >= command.length) break;
      const ch = command[i];
      if (";&|()`".includes(ch)) break;
      if (ch === '"' || ch === "'") {
        const close = command.indexOf(ch, i + 1);
        const end = close === -1 ? command.length : close + 1;
        tokens.push(command.slice(i, end));
        i = end;
      } else {
        let j = i;
        while (j < command.length && !/[\s;&|()`]/.test(command[j])) j++;
        tokens.push(command.slice(i, j));
        i = j;
      }
    }
    invocations.push(parseGitTokens(tokens));
    gitWord.lastIndex = i;
  }
  return invocations;
}

function parseGitTokens(tokens: string[]): ParsedGitInvocation {
  const inv: ParsedGitInvocation = {
    subcommand: "",
    repoRef: null,
    operationClass: "ambiguous",
    mutating: true,
    noVerify: false,
  };
  let i = 0;
  while (i < tokens.length && tokens[i].startsWith("-") && tokens[i] !== "-") {
    const flag = tokens[i];
    if (flag.includes("=")) {
      i++;
      continue;
    }
    if (GIT_VALUE_FLAGS[flag] === true) {
      const value = tokens[i + 1];
      if (value === undefined) return inv;
      if (flag === "-C") inv.repoRef = value;
      i += 2;
      continue;
    }
    i++;
  }
  inv.subcommand = unquoteToken(tokens[i] ?? "");
  const rest = tokens.slice(i + 1);
  if (inv.subcommand === "branch") {
    inv.operationClass = classifyBranchOperation(rest);
  } else if (inv.subcommand === "tag") {
    inv.operationClass = classifyTagOperation(rest);
  } else if (inv.subcommand === "worktree") {
    const first = rest[0] ? flagName(rest[0]) : "";
    inv.operationClass =
      first === "list" || first === "show" ? "read-only" : "local/ref-mutation";
  } else if (inv.subcommand === "fetch") {
    inv.operationClass = classifyFetchOperation(rest);
  } else if (inv.subcommand === "push") {
    inv.operationClass = "external-side-effect";
  } else if (inv.subcommand === "update-ref") {
    inv.operationClass = "local/ref-mutation";
  } else if (inv.subcommand === "remote") {
    inv.operationClass = classifyRemoteOperation(rest);
  } else if (READ_ONLY_GIT_SUBCOMMANDS[inv.subcommand] === true) {
    inv.operationClass = "read-only";
  } else if (LOCAL_MUTATION_GIT_SUBCOMMANDS[inv.subcommand] === true) {
    inv.operationClass = "local/ref-mutation";
  }
  inv.mutating =
    inv.operationClass === "local/ref-mutation" ||
    inv.operationClass === "ambiguous";
  inv.noVerify =
    rest.some((t) => unquoteToken(t) === "--no-verify") ||
    (inv.subcommand === "commit" &&
      rest.some((t) => unquoteToken(t) === "-n"));
  return inv;
}


/** Internal-URL targets are session resources, never filesystem paths. */
const INTERNAL_URI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;



const SECRET_BASENAMES = new Set([
  ".env",
  "credentials.json",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
]);

export function isSecretPath(filePath: string): boolean {
  const base = basename(filePath);
  if (SECRET_BASENAMES.has(base)) return true;
  if (base.startsWith(".env.")) return true;
  if (/\.(pem|key)$/.test(base)) return true;
  if (/credentials/.test(base)) return true;
  if (/^secrets\./.test(base)) return true;
  return false;
}

// ─── Guard verdicts (host-neutral) ──────────────────────────────────────

/** Verdict for a write/edit tool call aimed at filePath (session cwd ctxCwd). */
export function guardManagedWriteTarget(
  filePath: string | undefined,
  ctxCwd: string,
  opts: { taskRoot: string },
): GuardVerdict {
  if (!filePath) return undefined;
  // Internal URLs are dispatched by the core router, never resolved as
  // filesystem paths — skip classification entirely (field-run F1).
  if (INTERNAL_URI_RE.test(filePath.trim())) return undefined;

  // Session-bound cwd (NOT process.cwd()): workspace-rooted child sessions
  // share the parent process, so relative targets must resolve against the
  // session's own directory to classify the real write target.
  const cwd = realpath(ctxCwd);
  const abs = realpath(expandPath(filePath, cwd));
  if (isTemporaryPath(abs)) return undefined;
  const root = findGitRoot(abs);
  if (root && isGitMetadataPath(root, abs)) {
    return {
      block: true,
      reason: `Blocked: writing to Git metadata under ${join(root, ".git")} is not allowed.`,
    };
  }
  const classification = classifyPath(filePath, cwd, opts.taskRoot);

  if (classification === "PRIMARY_CHECKOUT") {
    // Ignored, untracked, non-symlink paths stay writable in the primary
    // checkout; everything else routes to the managed task worktree(s).
    if (root && !isAllowedIgnoredPrimaryPath(root, abs)) {
      const hint = managedWorktreeHint(root, opts.taskRoot);
      if (hint) {
        return {
          block: true,
          reason: `Blocked: writing to primary checkout ${root}. Use the managed task worktree(s) of this repo: ${hint}. This block is a routing failure, not a bypass authorization — do not work around it with eval, Python, shell, or another agent; write to the managed worktree or report the blocker.`,
        };
      }
    }
  }
  return undefined;
}

/** Verdict for a bash tool call running command (session cwd ctxCwd). */
export function guardManagedBashCommand(
  command: string | undefined,
  ctxCwd: string,
  opts: { taskRoot: string },
): GuardVerdict {
  if (!command) return undefined;

  const invocations = parseGitInvocations(command);

  // Raw hook bypass is policy, not routing: forbidden everywhere, including
  // managed worktrees. The controlled deferral path lives in
  // checkpoint_commit, which requires a real, current hook failure first.
  if (invocations.some((inv) => inv.mutating && inv.noVerify)) {
    return {
      block: true,
      reason:
        "Blocked: raw \`git commit --no-verify\` bypasses pre-commit hooks. Commit normally (hooks run); if a hook fails on an external prerequisite such as an unpublished same-task dependency, retry via checkpoint_commit with deferred_hook evidence.",
    };
  }
  const cwd = realpath(ctxCwd);
  if (
    hasTemporaryShellCwd(command) &&
    invocations.every((inv) => !inv.mutating || inv.repoRef === null)
  )
    return undefined;

  // Compound commands must not hide a mutating git invocation behind
  // read-only ones: EVERY git invocation in the command is classified, and
  // any mutating one aimed at a primary checkout with managed worktrees
  // blocks the whole command (fail closed on ambiguity).
  for (const inv of invocations) {
    if (!inv.mutating) continue;
    const repoRef = inv.repoRef ?? ".";
    // A URI-like repo ref (git -C local://… …) is never a filesystem repo.
    if (INTERNAL_URI_RE.test(repoRef.trim())) continue;
    const repoAbs = expandPath(repoRef, cwd);
    if (isTemporaryPath(repoAbs)) continue;
    let classification: PathClassification;
    try {
      classification = classifyPath(repoAbs, cwd, opts.taskRoot);
    } catch {
      continue; // unresolvable -C target can never be the primary checkout
    }
    if (classification !== "PRIMARY_CHECKOUT") continue;
    const root = findGitRoot(repoAbs);
    if (!root) continue;
    const hint = managedWorktreeHint(root, opts.taskRoot);
    if (!hint) continue;
    return {
      block: true,
      reason: `Blocked: mutating git command on primary checkout ${root}. Use the managed task worktree(s) of this repo: ${hint}. This block is a routing failure, not a bypass authorization — do not work around it with eval, Python, shell, or another agent; run the command in the managed worktree or report the blocker.`,
    };
  }
  return undefined;
}
