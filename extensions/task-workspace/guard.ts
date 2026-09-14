/**
 * task-workspace core — git mutation classification and guard verdicts.
 *
 * Recognizes direct, literal `git` invocations in shell COMMAND position —
 * a lexical, quote/escape-aware scan with recursion into `$(...)`/backticks
 * and assignment-prefix/comment handling; never any occurrence of the word
 * "git" — and produces host-neutral guard verdicts for write/edit targets
 * and bash commands: local ref mutations route to managed worktrees (the
 * `cd <path> &&` override is limited to git-only chains), raw `--no-verify`
 * is blocked everywhere, and input beyond the scanner's recursion limit is
 * blocked as unanalyzable. Everything else fails closed. A net against
 * routing mistakes, not a sandbox. The host binding maps a verdict onto its
 * own tool-call block.
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
  hasExpansion: boolean;
  hasUnquotedGlob: boolean;
}

type Emit = (words: ShellWord[]) => void;
type ControlOperator = ";" | "&&" | "||" | "|" | "&" | "\n";
interface ScanState {
  unanalyzable: boolean;
}

/** Shell nesting is recursive in the lexer, but hostile input must never
 *  exhaust the JavaScript stack. Crossing this limit marks the whole command
 *  unanalyzable; the bash guard then blocks it. */
const MAX_SCANNER_RECURSION_DEPTH = 64;

/** Leading NAME=value words at command position are skipped by the scanner
 *  while it stays at command position (`GIT_DIR=x git commit`). */
const ASSIGNMENT_WORD_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ARRAY_ASSIGNMENT_WORD_RE = /^([A-Za-z_][A-Za-z0-9_]*\+?=)$/;
const TRANSPARENT_RESERVED_WORDS = new Set([
  "!",
  "time",
  "if",
  "then",
  "elif",
  "else",
  "do",
  "while",
  "until",
  "for",
  "select",
  "coproc",
  "case",
]);

type CasePhase = "subject" | "in" | "pattern" | "body";
interface CaseContext {
  phase: CasePhase;
}

/** Lexically scan one shell command list from `start`, visiting every simple
 *  command's words at command position. Command position: string start and
 *  after `;`, `&&`, `||`, `|`, `&`, `(`, newline. Stops at a bare `)` (the
 *  close of an enclosing `$(...)` substitution) or end of input and returns
 *  the stop index. Assignment prefixes are skipped; `#` at word start
 *  comments out the rest of the line; redirections are skipped together with
 *  their target word. Every branch advances — no termination loops. */
function scanShellList(
  command: string,
  start: number,
  visit: Emit,
  state: ScanState,
  depth = 0,
  onTopLevelControl?: (operator: ControlOperator) => void,
): number {
  if (depth > MAX_SCANNER_RECURSION_DEPTH) {
    state.unanalyzable = true;
    return command.length;
  }

  let i = start;
  let atCommand = true;
  let words: ShellWord[] = [];
  let raw = "";
  let literal = "";
  let hasExpansion = false;
  let hasUnquotedGlob = false;
  let inWord = false;
  let braceGroupDepth = 0;
  let timeMayTakePortableOption = false;
  const caseStack: CaseContext[] = [];

  const currentCase = (): CaseContext | undefined => caseStack.at(-1);
  const clearWord = (): void => {
    raw = "";
    literal = "";
    hasExpansion = false;
    hasUnquotedGlob = false;
  };
  const endWord = (): void => {
    if (!inWord) return;
    inWord = false;
    if (atCommand && words.length === 0) {
      const caseContext = currentCase();
      if (caseContext?.phase === "subject") {
        caseContext.phase = "in";
        clearWord();
        return;
      }
      if (caseContext?.phase === "in") {
        if (hasExpansion || raw !== "in" || literal !== "in") {
          state.unanalyzable = true;
        }
        caseContext.phase = "pattern";
        clearWord();
        return;
      }
      if (caseContext?.phase === "pattern") {
        if (!hasExpansion && raw === "esac" && literal === "esac") {
          caseStack.pop();
          clearWord();
          atCommand = false;
          return;
        }
        // Case patterns are data. An attached ')' branch below moves the
        // scanner into the executable body.
        clearWord();
        return;
      }
      if (
        caseContext?.phase === "body" &&
        !hasExpansion &&
        raw === "esac" &&
        literal === "esac"
      ) {
        caseStack.pop();
        clearWord();
        atCommand = false;
        return;
      }
      if (
        timeMayTakePortableOption &&
        !hasExpansion &&
        raw === "-p" &&
        literal === "-p"
      ) {
        timeMayTakePortableOption = false;
        clearWord();
        return;
      }
      if (ASSIGNMENT_WORD_RE.test(raw)) {
        clearWord();
        return; // assignment prefix: skipped, command position retained
      }
      if (!hasExpansion && raw === literal && TRANSPARENT_RESERVED_WORDS.has(literal)) {
        if (literal === "time") timeMayTakePortableOption = true;
        if (literal === "case") caseStack.push({ phase: "subject" });
        clearWord();
        return;
      }
      if (!hasExpansion && raw === "{" && literal === "{") {
        braceGroupDepth++;
        clearWord();
        return;
      }
      if (!hasExpansion && raw === "}" && literal === "}" && braceGroupDepth > 0) {
        braceGroupDepth--;
        clearWord();
        atCommand = false;
        return;
      }
    }
    timeMayTakePortableOption = false;
    words.push({ raw, literal, hasExpansion, hasUnquotedGlob });
    atCommand = false;
    clearWord();
  };
  const flushCommand = (): void => {
    endWord();
    if (words.length > 0) visit(words);
    words = [];
  };
  const separator = (operator: ControlOperator): void => {
    // Flush first so a `}` immediately before the operator closes its brace
    // group before top-level control flow is classified.
    flushCommand();
    if (braceGroupDepth === 0) onTopLevelControl?.(operator);
    timeMayTakePortableOption = false;
    atCommand = true;
  };

  while (i < command.length) {
    const ch = command[i]!;
    if (ch === ")") {
      const caseContext = currentCase();
      if (caseContext?.phase === "pattern") {
        if (!inWord) {
          state.unanalyzable = true;
          return i;
        }
        // Only an attached ')' closes a recognized case pattern. The pattern
        // itself is data and must not be visited as a command.
        clearWord();
        inWord = false;
        caseContext.phase = "body";
        i++;
        atCommand = true;
        continue;
      }
      flushCommand();
      return i;
    }
    if (ch === "\n") {
      separator("\n");
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      endWord();
      i++;
      continue;
    }
    if (ch === ";") {
      const caseContext = currentCase();
      if (caseContext?.phase === "body" && command[i + 1] === ";") {
        separator(";");
        caseContext.phase = "pattern";
        i += 2;
        continue;
      }
      separator(";");
      i++;
      continue;
    }
    if (ch === "|" && currentCase()?.phase === "pattern") {
      // Pattern alternatives are data, not pipelines.
      endWord();
      i++;
      continue;
    }
    if (ch === "|") {
      const operator = command[i + 1] === "|" ? "||" : "|";
      separator(operator);
      i += operator.length;
      continue;
    }
    if (ch === "&") {
      if (command[i + 1] === ">") {
        i = readRedirection(command, i, visit, state, depth);
        continue;
      }
      const operator = command[i + 1] === "&" ? "&&" : "&";
      separator(operator);
      i += operator.length;
      continue;
    }
    if (ch === "(") {
      if (inWord && ARRAY_ASSIGNMENT_WORD_RE.test(raw)) {
        // Bash array assignment contents are data, not a subshell. The lack
        // of whitespace before '(' is significant. Function definitions do
        // not match because their pending word has no '='.
        clearWord();
        inWord = false;
        i = skipParens(command, i);
        atCommand = false;
        continue;
      }
      if (currentCase()?.phase === "pattern" && !inWord) {
        // Bash permits an optional opening '(' before a case pattern.
        i++;
        continue;
      }
      // Subshell: its content is a nested command list that really executes.
      flushCommand();
      atCommand = true;
      const close = scanShellList(command, i + 1, visit, state, depth + 1);
      i = Math.min(close + 1, command.length);
      atCommand = false;
      continue;
    }
    if (ch === "<" || ch === ">") {
      // A bare digit or `{name}` immediately before the operator is an fd.
      if (
        inWord &&
        !hasExpansion &&
        (/^[0-9]+$/.test(raw) || /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(raw))
      ) {
        clearWord();
        inWord = false;
      } else {
        endWord();
      }
      i = readRedirection(command, i, visit, state, depth);
      continue;
    }
    if (ch === "#" && !inWord) {
      // Comment: skip to end of line (the newline itself re-opens command
      // position).
      while (i < command.length && command[i] !== "\n") i++;
      continue;
    }
    const word = readShellWord(command, i, visit, state, depth);
    if (word.raw !== "") {
      // A bare \<newline> continuation reads as an empty word and must not
      // end command position or inject an empty token.
      raw += word.raw;
      literal += word.literal;
      hasExpansion ||= word.hasExpansion;
      hasUnquotedGlob ||= word.hasUnquotedGlob;
      inWord = true;
    }
    i = word.next;
  }
  flushCommand();
  if (caseStack.length > 0) state.unanalyzable = true;
  return i;
}

/** Skip a redirection operator (`<`, `>`, `>>`, `2>`, `>&`, `&>`, `>|`,
 *  heredoc/herestring operators) and its target word. Command position is
 *  unaffected: a redirection is part of the current simple command. Heredoc
 *  bodies are intentionally not modeled — the following lines stay parsed as
 *  commands, which fails closed. */
function readRedirection(
  command: string,
  i: number,
  visit: Emit,
  state: ScanState,
  depth: number,
): number {
  while (i < command.length && (command[i] === "<" || command[i] === ">")) i++;
  if (command[i] === "|" || command[i] === "&") i++;
  while (i < command.length && (command[i] === "<" || command[i] === ">")) i++;
  while (i < command.length && /\s/.test(command[i]!) && command[i] !== "\n") i++;
  if (i >= command.length) return i;
  if (/[\s;&|()`<>]/.test(command[i]!)) return i; // no/invalid target: nothing to skip
  return readShellWord(command, i, visit, state, depth).next;
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
  state: ScanState,
  depth: number,
): ShellWord & { next: number } {
  let i = start;
  let raw = "";
  let literal = "";
  let hasExpansion = false;
  let hasUnquotedGlob = false;
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
      const part = readDoubleQuoted(command, i, visit, state, depth);
      raw += part.raw;
      literal += part.literal;
      hasExpansion ||= part.hasExpansion;
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
      const part = readDollarExpansion(command, i, visit, state, depth);
      raw += part.raw;
      hasExpansion = true;
      i = part.next;
      continue; // expansion output contributes no literal
    }
    if (ch === "`") {
      const part = readBacktickSubstitution(command, i, visit, state, depth);
      raw += part.raw;
      hasExpansion = true;
      i = part.next;
      continue; // substitution output contributes no literal
    }
    if (/[\s;&|()`<>]/.test(ch)) break; // end of word
    raw += ch;
    literal += ch;
    hasUnquotedGlob ||= ch === "*" || ch === "?" || ch === "[";
    i++;
  }
  return { raw, literal, hasExpansion, hasUnquotedGlob, next: i };
}

/** Read a double-quoted string starting at its opening `"` (kept in raw).
 *  `\` escapes `$`, backtick, `"`, `\` and newlines; `$(...)` and backticks
 *  inside are recursed with `visit` (executed shell) and contribute no
 *  literal. */
function readDoubleQuoted(
  command: string,
  start: number,
  visit: Emit,
  state: ScanState,
  depth: number,
): { raw: string; literal: string; hasExpansion: boolean; next: number } {
  let i = start + 1;
  let raw = '"';
  let literal = "";
  let hasExpansion = false;
  while (i < command.length) {
    const ch = command[i]!;
    if (ch === '"') {
      return { raw: raw + '"', literal, hasExpansion, next: i + 1 };
    }
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
      const part = readDollarExpansion(command, i, visit, state, depth);
      raw += part.raw;
      hasExpansion = true;
      i = part.next;
      continue;
    }
    if (ch === "`") {
      const part = readBacktickSubstitution(command, i, visit, state, depth);
      raw += part.raw;
      hasExpansion = true;
      i = part.next;
      continue;
    }
    raw += ch;
    literal += ch;
    i++;
  }
  return { raw, literal, hasExpansion, next: i }; // unterminated quote
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
  state: ScanState,
  depth: number,
): { raw: string; next: number } {
  const nxt = command[i + 1];
  if (nxt === "(") {
    if (command[i + 2] === "(") {
      const end = skipParens(command, i + 1);
      const bodyEnd = command[end - 1] === ")" ? Math.max(i + 3, end - 2) : end;
      scanNestedSubstitutions(command, i + 3, bodyEnd, visit, state, depth + 1);
      return { raw: command.slice(i, end), next: end };
    }
    // scanShellList stops at the matching `)` because it is quote-aware.
    const stop = scanShellList(command, i + 2, visit, state, depth + 1);
    const end = Math.min(stop + 1, command.length);
    return { raw: command.slice(i, end), next: end };
  }
  if (nxt === "{") {
    const end = skipBraces(command, i + 2);
    const bodyEnd = command[end - 1] === "}" ? end - 1 : end;
    scanNestedSubstitutions(command, i + 2, bodyEnd, visit, state, depth + 1);
    return { raw: command.slice(i, end), next: end };
  }
  let j = i + 1;
  while (j < command.length && /[A-Za-z0-9_*@#?!-]/.test(command[j]!)) j++;
  return { raw: command.slice(i, j), next: j };
}

/** `${...}` and `$((...))` are opaque to literal-word recognition, but their
 *  bodies can contain command substitutions that execute. Find only those
 *  nested `$()` and backtick spans, then feed their bodies back through the
 *  command-list scanner. */
function scanNestedSubstitutions(
  command: string,
  start: number,
  end: number,
  visit: Emit,
  state: ScanState,
  depth: number,
): void {
  if (depth > MAX_SCANNER_RECURSION_DEPTH) {
    state.unanalyzable = true;
    return;
  }

  let i = start;
  let quote: "none" | "single" | "double" = "none";
  while (i < end && !state.unanalyzable) {
    const ch = command[i]!;
    if (quote === "single") {
      if (ch === "'") quote = "none";
      i++;
      continue;
    }
    if (ch === "\\") {
      i = Math.min(i + 2, end);
      continue;
    }
    if (ch === "'" && quote === "none") {
      quote = "single";
      i++;
      continue;
    }
    if (ch === '"') {
      quote = quote === "double" ? "none" : "double";
      i++;
      continue;
    }
    if (ch === "$" && (command[i + 1] === "(" || command[i + 1] === "{")) {
      const part = readDollarExpansion(command, i, visit, state, depth);
      i = Math.max(i + 1, Math.min(part.next, end));
      continue;
    }
    if (ch === "`") {
      const part = readBacktickSubstitution(command, i, visit, state, depth);
      i = Math.max(i + 1, Math.min(part.next, end));
      continue;
    }
    i++;
  }
}

/** Read a backtick substitution starting at `i` (POSIX: the first unescaped
 *  backtick closes it). Its contents are executed shell and recursed with
 *  `visit` via a bounded sub-scan. */
function readBacktickSubstitution(
  command: string,
  i: number,
  visit: Emit,
  state: ScanState,
  depth: number,
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
  scanShellList(command.slice(i + 1, j), 0, visit, state, depth + 1);
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
interface GitInvocationAnalysis {
  invocations: ParsedGitInvocation[];
  unanalyzable: boolean;
}

function analyzeGitInvocations(command: string): GitInvocationAnalysis {
  const invocations: ParsedGitInvocation[] = [];
  const state: ScanState = { unanalyzable: false };
  scanShellList(
    command,
    0,
    (words) => {
      if (words[0]?.literal !== "git" || words[0].hasExpansion) return;
      invocations.push(parseGitTokens(words.slice(1).map((w) => w.raw)));
    },
    state,
  );
  return { invocations, unanalyzable: state.unanalyzable };
}

export function parseGitInvocations(command: string): ParsedGitInvocation[] {
  return analyzeGitInvocations(command).invocations;
}

/** Literal cd target of the EXACT `cd <path> &&` idiom, or null. The target
 *  is a single fully-literal word resolved by the same word reader (quotes
 *  and backslash escapes allowed; no expansion, no unquoted glob syntax, not
 *  starting with `-`). The remainder may contain only literal git commands,
 *  assignment prefixes, and recognized reserved words, joined at top level
 *  only by `&&`. Any other command word, later cd, or unsafe control operator
 *  returns null, so an implicit "." resolves against the session cwd. */
export function resolveCommandCwdPrefix(command: string): string | null {
  const noop = (): void => {};
  const state: ScanState = { unanalyzable: false };
  let i = 0;
  while (i < command.length && /\s/.test(command[i]!) && command[i] !== "\n") i++;
  const cd = readShellWord(command, i, noop, state, 0);
  if (cd.literal !== "cd" || cd.raw === "" || cd.hasExpansion) return null;
  i = cd.next;
  if (i >= command.length || command[i] === "\n" || !/\s/.test(command[i]!)) return null;
  while (i < command.length && /\s/.test(command[i]!) && command[i] !== "\n") i++;
  if (i >= command.length || command[i] === "\n") return null;
  const target = readShellWord(command, i, noop, state, 0);
  if (target.raw === "" || target.raw.startsWith("-")) return null;
  // Bash expands ~+ and ~- from the shell directory stack, while ~name uses
  // the named user's home. expandPath does not model those semantics, so only
  // plain ~ and ~/... are accepted for the cwd override.
  if (
    target.literal.startsWith("~") &&
    target.literal !== "~" &&
    !target.literal.startsWith("~/")
  ) {
    return null;
  }
  // Keep computed targets fail closed, including conservative rejection of a
  // quoted dollar/backtick. Unquoted glob syntax can redirect cd at runtime;
  // quoted glob characters remain literal and are safe.
  if (
    state.unanalyzable ||
    target.hasExpansion ||
    target.raw.includes("$") ||
    target.raw.includes("`") ||
    target.hasUnquotedGlob
  ) {
    return null;
  }
  i = target.next;
  while (i < command.length && /\s/.test(command[i]!) && command[i] !== "\n") i++;
  if (command[i] !== "&" || command[i + 1] !== "&") return null;
  if (!isSafeCwdRemainder(command.slice(i + 2))) return null;
  return target.literal;
}

/** The initial cd remains authoritative only when every executable command
 *  in the remainder is literal git and the top-level list is joined by `&&`.
 *  Assignments and recognized reserved words are transparent. Any other
 *  command denies the override, even if it cannot change cwd. This deliberate
 *  fail-closed rule means `cd <worktree> && gh ... && git commit` must use
 *  `git -C <worktree>` instead. */
function isSafeCwdRemainder(remainder: string): boolean {
  let hasCd = false;
  let hasNonGitCommand = false;
  let unsafeControl = false;
  const state: ScanState = { unanalyzable: false };
  scanShellList(
    remainder,
    0,
    (words) => {
      const commandWord = words[0];
      if (commandWord?.literal === "cd" && !commandWord.hasExpansion) hasCd = true;
      if (commandWord?.literal !== "git" || commandWord.hasExpansion) {
        hasNonGitCommand = true;
      }
    },
    state,
    0,
    (operator) => {
      if (operator === ";" || operator === "||" || operator === "&" || operator === "\n") {
        unsafeControl = true;
      }
    },
  );
  return !state.unanalyzable && !hasCd && !hasNonGitCommand && !unsafeControl;
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

  const cwd = realpath(ctxCwd);
  const analysis = analyzeGitInvocations(command);
  const invocations = analysis.invocations;
  if (analysis.unanalyzable) {
    const root = findGitRoot(cwd);
    const hint = root ? managedWorktreeHint(root, opts.taskRoot) : null;
    return {
      block: true,
      reason: hint
        ? `Blocked: bash command exceeds the shell scanner nesting limit, so git routing cannot be analyzed safely. Use the managed task worktree(s) of this repo: ${hint}. This block is a routing failure, not a bypass authorization; split or simplify the command.`
        : "Blocked: bash command exceeds the shell scanner nesting limit, so git routing cannot be analyzed safely. Use the managed task worktree(s). This block is a routing failure, not a bypass authorization; split or simplify the command.",
    };
  }

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
  // The exact `cd <path> &&` idiom re-points the implicit repo target only
  // for a git-only remainder. A failed cd short-circuits the shell, and no
  // accepted later command can change the parent shell cwd. Other commands,
  // a second cd, unsafe control flow, or a computed target fail closed to the
  // session cwd via resolveCommandCwdPrefix returning null.
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
