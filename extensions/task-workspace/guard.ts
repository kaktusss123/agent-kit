/**
 * task-workspace core — git mutation classification and guard verdicts.
 *
 * Recognizes direct, literal `git` invocations in shell COMMAND position —
 * a lexical, quote/escape-aware scan with recursion into `$(...)`/backticks
 * and assignment-prefix/comment handling; never any occurrence of the word
 * "git" — and produces host-neutral guard verdicts for write/edit targets
 * and bash commands: local ref mutations route to managed worktrees (the
 * plain `cd <path> &&` idiom is honored), raw `--no-verify` is blocked
 * everywhere, everything else fails closed. A net against routing mistakes,
 * not a sandbox. The host binding maps a verdict onto its own tool-call
 * block.
 */
import { basename, join } from "node:path";
import {
  classifyPath,
  expandPath,
  findGitRoot,
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

// ─── Shell lexer: command-position git discovery ──────────────────────────
//
// The guard recognizes a direct, literal `git` invocation in shell COMMAND
// position — never any occurrence of the word "git". This is a lexical scan
// (words, shell operators, quote/escape awareness), explicitly NOT a bash
// interpreter. Deliberately NOT modeled — blind spots, do not "fix" here:
// heredoc bodies remain parsed as commands (fail closed, same as today);
// wrapper commands (`sudo git`, `env git`, `xargs git`, `command git`),
// computed command words (`$(echo git) commit`) and `/usr/bin/git` are not
// detected. The guard is a routing-mistake net, not a sandbox.

/** One shell word: `raw` is the byte slice of the command (fed to
 *  parseGitTokens, byte-for-byte as before) and `literal` is the fully
 *  resolved text (quotes stripped, escapes resolved) used only to recognize
 *  the command word itself. Substitution output is runtime data and
 *  contributes nothing to `literal`. */
interface ShellWord {
  raw: string;
  literal: string;
}

type Emit = (words: ShellWord[]) => void;

/** Leading NAME=value words at command position are skipped by the scanner
 *  while it stays at command position (`GIT_DIR=x git commit`). */
const ASSIGNMENT_WORD_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Lexically scan one shell command list from `start`, visiting every simple
 *  command's words at command position. Command position: string start and
 *  after `;`, `&&`, `||`, `|`, `&`, `(`, newline. Stops at a bare `)` (the
 *  close of an enclosing `$(...)` substitution) or end of input and returns
 *  the stop index. Assignment prefixes are skipped; `#` at word start
 *  comments out the rest of the line; redirections are skipped together with
 *  their target word. Every branch advances — no termination loops. */
function scanShellList(command: string, start: number, visit: Emit): number {
  let i = start;
  let atCommand = true;
  let words: ShellWord[] = [];
  let raw = "";
  let literal = "";
  let inWord = false;

  const endWord = (): void => {
    if (!inWord) return;
    inWord = false;
    if (atCommand && words.length === 0 && ASSIGNMENT_WORD_RE.test(raw)) {
      raw = "";
      literal = "";
      return; // assignment prefix: skipped, command position retained
    }
    words.push({ raw, literal });
    atCommand = false;
    raw = "";
    literal = "";
  };
  const flushCommand = (): void => {
    endWord();
    if (words.length > 0) visit(words);
    words = [];
  };
  const separator = (): void => {
    flushCommand();
    atCommand = true;
  };

  while (i < command.length) {
    const ch = command[i]!;
    if (ch === ")") {
      flushCommand();
      return i;
    }
    if (ch === "\n") {
      separator();
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      endWord();
      i++;
      continue;
    }
    if (ch === ";") {
      separator();
      i++;
      continue;
    }
    if (ch === "|") {
      separator();
      i += command[i + 1] === "|" ? 2 : 1;
      continue;
    }
    if (ch === "&") {
      if (command[i + 1] === "&") {
        separator();
        i += 2;
        continue;
      }
      if (command[i + 1] === ">") {
        i = readRedirection(command, i, visit);
        continue;
      }
      separator();
      i++;
      continue;
    }
    if (ch === "(") {
      // Subshell: its content is a nested command list that really executes.
      separator();
      const close = scanShellList(command, i + 1, visit);
      i = Math.min(close + 1, command.length);
      atCommand = false;
      continue;
    }
    if (ch === "<" || ch === ">") {
      // A bare digit word immediately before the operator is an fd number.
      if (inWord && /^[0-9]+$/.test(raw)) {
        raw = "";
        literal = "";
        inWord = false;
      } else {
        endWord();
      }
      i = readRedirection(command, i, visit);
      continue;
    }
    if (ch === "#" && !inWord) {
      // Comment: skip to end of line (the newline itself re-opens command
      // position).
      while (i < command.length && command[i] !== "\n") i++;
      continue;
    }
    const word = readShellWord(command, i, visit);
    if (word.raw !== "") {
      // A bare \<newline> continuation reads as an empty word and must not
      // end command position or inject an empty token.
      raw += word.raw;
      literal += word.literal;
      inWord = true;
    }
    i = word.next;
  }
  flushCommand();
  return i;
}

/** Skip a redirection operator (`<`, `>`, `>>`, `2>`, `>&`, `&>`, `>|`,
 *  heredoc/herestring operators) and its target word. Command position is
 *  unaffected: a redirection is part of the current simple command. Heredoc
 *  bodies are intentionally not modeled — the following lines stay parsed as
 *  commands, which fails closed. */
function readRedirection(command: string, i: number, visit: Emit): number {
  while (i < command.length && (command[i] === "<" || command[i] === ">")) i++;
  if (command[i] === "|" || command[i] === "&") i++;
  while (i < command.length && (command[i] === "<" || command[i] === ">")) i++;
  while (i < command.length && /\s/.test(command[i]!) && command[i] !== "\n") i++;
  if (i >= command.length) return i;
  if (/[\s;&|()`<>]/.test(command[i]!)) return i; // no/invalid target: nothing to skip
  return readShellWord(command, i, visit).next;
}

/** Read one shell word starting at `i`: single/double quotes, backslash
 *  escapes (including `\<newline>` continuations), `$`-expansions and
 *  backticks (recursed with `visit` — that content is executed shell and
 *  contributes no literal), stopping before whitespace, a control operator,
 *  `)` or end of input. Mid-word quote concatenation (`g"it"`) resolves in
 *  the literal. */
function readShellWord(
  command: string,
  start: number,
  visit: Emit,
): { raw: string; literal: string; next: number } {
  let i = start;
  let raw = "";
  let literal = "";
  while (i < command.length) {
    const ch = command[i]!;
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      const end = close === -1 ? command.length : close + 1;
      raw += command.slice(i, end);
      literal += command.slice(i + 1, close === -1 ? command.length : close);
      i = end;
      continue;
    }
    if (ch === '"') {
      const part = readDoubleQuoted(command, i, visit);
      raw += part.raw;
      literal += part.literal;
      i = part.next;
      continue;
    }
    if (ch === "\\") {
      const nxt = command[i + 1];
      if (nxt === "\n") {
        i += 2; // line continuation: splices, leaves neither raw nor literal
        continue;
      }
      if (nxt === undefined) {
        raw += "\\";
        i++;
        continue;
      }
      raw += "\\" + nxt;
      literal += nxt;
      i += 2;
      continue;
    }
    if (ch === "$") {
      const part = readDollarExpansion(command, i, visit);
      raw += part.raw;
      i = part.next;
      continue; // expansion output contributes no literal
    }
    if (ch === "`") {
      const part = readBacktickSubstitution(command, i, visit);
      raw += part.raw;
      i = part.next;
      continue; // substitution output contributes no literal
    }
    if (/[\s;&|()`<>]/.test(ch)) break; // end of word
    raw += ch;
    literal += ch;
    i++;
  }
  return { raw, literal, next: i };
}

/** Read a double-quoted string starting at its opening `"` (kept in raw).
 *  `\` escapes `$`, backtick, `"`, `\` and newlines; `$(...)` and backticks
 *  inside are recursed with `visit` (executed shell) and contribute no
 *  literal. */
function readDoubleQuoted(
  command: string,
  start: number,
  visit: Emit,
): { raw: string; literal: string; next: number } {
  let i = start + 1;
  let raw = '"';
  let literal = "";
  while (i < command.length) {
    const ch = command[i]!;
    if (ch === '"') return { raw: raw + '"', literal, next: i + 1 };
    if (ch === "\\") {
      const nxt = command[i + 1];
      if (nxt === "$" || nxt === "`" || nxt === '"' || nxt === "\\") {
        raw += "\\" + nxt;
        literal += nxt;
        i += 2;
        continue;
      }
      if (nxt === "\n") {
        i += 2;
        continue;
      }
      raw += "\\";
      i++;
      continue;
    }
    if (ch === "$") {
      const part = readDollarExpansion(command, i, visit);
      raw += part.raw;
      i = part.next;
      continue;
    }
    if (ch === "`") {
      const part = readBacktickSubstitution(command, i, visit);
      raw += part.raw;
      i = part.next;
      continue;
    }
    raw += ch;
    literal += ch;
    i++;
  }
  return { raw, literal, next: i }; // unterminated quote
}

/** Read a `$`-expansion at `i` (raw only; the output contributes no
 *  literal). `$(...)` contents are executed shell and recursed with `visit`
 *  — that recursion is what detects `echo "$(git commit ...)"`. `$((` is
 *  treated as arithmetic (paren counting); `$( (` stays a substitution, so a
 *  subshell inside it is still scanned. */
function readDollarExpansion(
  command: string,
  i: number,
  visit: Emit,
): { raw: string; next: number } {
  const nxt = command[i + 1];
  if (nxt === "(") {
    if (command[i + 2] === "(") {
      const end = skipParens(command, i + 1);
      return { raw: command.slice(i, end), next: end };
    }
    // scanShellList stops at the matching `)` because it is quote-aware.
    const stop = scanShellList(command, i + 2, visit);
    const end = Math.min(stop + 1, command.length);
    return { raw: command.slice(i, end), next: end };
  }
  if (nxt === "{") {
    const end = skipBraces(command, i + 2);
    return { raw: command.slice(i, end), next: end };
  }
  let j = i + 1;
  while (j < command.length && /[A-Za-z0-9_*@#?!-]/.test(command[j]!)) j++;
  return { raw: command.slice(i, j), next: j };
}

/** Read a backtick substitution starting at `i` (POSIX: the first unescaped
 *  backtick closes it). Its contents are executed shell and recursed with
 *  `visit` via a bounded sub-scan. */
function readBacktickSubstitution(
  command: string,
  i: number,
  visit: Emit,
): { raw: string; next: number } {
  let j = i + 1;
  while (j < command.length && command[j] !== "`") {
    j =
      command[j] === "\\" &&
      (command[j + 1] === "$" || command[j + 1] === "`" || command[j + 1] === "\\")
        ? j + 2
        : j + 1;
  }
  const end = j < command.length ? j + 1 : j; // past closing backtick, or end
  scanShellList(command.slice(i + 1, j), 0, visit);
  return { raw: command.slice(i, end), next: end };
}

/** Skip from `i` (at `(`) to just past the matching `)`. */
function skipParens(command: string, i: number): number {
  let depth = 0;
  while (i < command.length) {
    const ch = command[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return i;
}

/** Skip from `i` (just past `${`) to just past the matching `}`. */
function skipBraces(command: string, i: number): number {
  let depth = 1;
  while (i < command.length) {
    const ch = command[i]!;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return i;
}

/** Conservative scan of EVERY direct, literal `git` invocation in a
 *  (possibly compound) shell command, recognized in shell COMMAND position
 *  by the lexical scanner above. It is not a shell interpreter: ambiguous
 *  input errs toward local/ref-mutation so the guard fails closed. Tokens
 *  stay the RAW slices after the `git` word, so parseGitTokens, the
 *  subcommand classifiers and `--no-verify` detection behave exactly as
 *  before. */
export function parseGitInvocations(command: string): ParsedGitInvocation[] {
  const invocations: ParsedGitInvocation[] = [];
  scanShellList(command, 0, (words) => {
    if (words[0]?.literal !== "git") return;
    invocations.push(parseGitTokens(words.slice(1).map((w) => w.raw)));
  });
  return invocations;
}

/** Literal cd target of the EXACT `cd <path> &&` idiom, or null. The target
 *  is a single fully-literal word resolved by the same word reader (quotes
 *  and backslash escapes allowed; no `$var`, no `$(...)`, no backticks; not
 *  starting with `-`). Returns null — fail closed, so an implicit "."
 *  resolves against the session cwd as before — when the prefix shape
 *  differs in any way, when `||`, `;` or a newline appears where `&&` is
 *  required, or when ANY `cd` appears as a command word anywhere in the
 *  remainder (scanner-checked, including inside substitutions and
 *  subshells). With `&&` a failed cd short-circuits the shell, so resolving
 *  "." against the target can never allow a mutation that actually runs in
 *  the session cwd; with `;` or `||` it could — hence the strict shape. */
export function resolveCommandCwdPrefix(command: string): string | null {
  const noop = (): void => {};
  let i = 0;
  while (i < command.length && /\s/.test(command[i]!) && command[i] !== "\n") i++;
  const cd = readShellWord(command, i, noop);
  if (cd.literal !== "cd" || cd.raw === "") return null;
  i = cd.next;
  if (i >= command.length || command[i] === "\n" || !/\s/.test(command[i]!)) return null;
  while (i < command.length && /\s/.test(command[i]!) && command[i] !== "\n") i++;
  if (i >= command.length || command[i] === "\n") return null;
  const target = readShellWord(command, i, noop);
  if (target.raw === "" || target.raw.startsWith("-")) return null;
  if (target.raw.includes("$") || target.raw.includes("`")) return null;
  i = target.next;
  while (i < command.length && /\s/.test(command[i]!) && command[i] !== "\n") i++;
  if (command[i] !== "&" || command[i + 1] !== "&") return null;
  if (hasCdCommandWord(command.slice(i + 2))) return null;
  return target.literal;
}

/** True when the remainder contains `cd` as a command word anywhere the
 *  scanner reaches (including subshells and command substitutions). */
function hasCdCommandWord(remainder: string): boolean {
  let found = false;
  scanShellList(remainder, 0, (words) => {
    if (words[0]?.literal === "cd") found = true;
  });
  return found;
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
  // The exact `cd <path> &&` idiom re-points the implicit repo target: a
  // failed cd short-circuits the shell (&&), so this can never allow a
  // mutation that actually runs in the session cwd. Anything else — a
  // second cd, `;`/`||`, a computed target — fails closed to the session
  // cwd via resolveCommandCwdPrefix returning null.
  const cdLiteral = resolveCommandCwdPrefix(command);
  const cdBase = cdLiteral === null ? null : expandPath(cdLiteral, cwd);

  // Compound commands must not hide a mutating git invocation behind
  // read-only ones: EVERY git invocation in the command is classified, and
  // any mutating one aimed at a primary checkout with managed worktrees
  // blocks the whole command (fail closed on ambiguity).
  for (const inv of invocations) {
    if (!inv.mutating) continue;
    const repoRef = inv.repoRef ?? ".";
    // A URI-like repo ref (git -C local://… …) is never a filesystem repo.
    if (INTERNAL_URI_RE.test(repoRef.trim())) continue;
    const repoAbs =
      inv.repoRef === null && cdBase !== null ? cdBase : expandPath(repoRef, cwd);
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
