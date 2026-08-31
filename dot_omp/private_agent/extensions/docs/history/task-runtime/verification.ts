/**
 * Verification contract and runtime check execution.
 *
 * The contract is structured data (approved at approval time), not free text.
 * Required checks must pass for `task_submit` to transition `implementing
 * → completed`. Optional checks surface failures but do not block.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  specPath,
  verificationPath,
  worktreePath,
} from "./paths.ts";
import type {
  CheckOutcome,
  ExecFn,
  TaskManifestV2,
  VerificationCheck,
  VerificationContract,
  VerificationRunResult,
} from "./types.ts";

export class VerificationContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationContractError";
  }
}

const TAIL_BYTES = 4096;
const HARD_TIMEOUT_MS = 5 * 60 * 1000;

export function readVerificationContract(taskId: string): VerificationContract {
  const p = verificationPath(taskId);
  if (!existsSync(p)) return { checks: [] };
  const text = readFileSync(p, "utf8");
  return parseContract(text);
}

export function parseContract(raw: string): VerificationContract {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new VerificationContractError(`not valid JSON: ${(e as Error).message}`);
  }
  if (!obj || typeof obj !== "object") {
    throw new VerificationContractError("root must be an object");
  }
  const c = obj as { checks?: unknown; manualReason?: unknown };
  if (!Array.isArray(c.checks)) {
    throw new VerificationContractError("checks must be an array");
  }
  const checks: VerificationCheck[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < c.checks.length; i++) {
    const r = c.checks[i] as { id?: unknown; repo?: unknown; command?: unknown; required?: unknown };
    if (typeof r.id !== "string" || r.id.length === 0) {
      throw new VerificationContractError(`check[${i}]: id must be non-empty string`);
    }
    if (seen.has(r.id)) {
      throw new VerificationContractError(`check[${i}]: duplicate id "${r.id}"`);
    }
    seen.add(r.id);
    if (typeof r.repo !== "string" || r.repo.length === 0) {
      throw new VerificationContractError(`check[${i}]: repo must be non-empty string`);
    }
    if (typeof r.command !== "string" || r.command.length === 0) {
      throw new VerificationContractError(`check[${i}]: command must be non-empty string`);
    }
    if (typeof r.required !== "boolean") {
      throw new VerificationContractError(`check[${i}]: required must be boolean`);
    }
    checks.push({ id: r.id, repo: r.repo, command: r.command, required: r.required });
  }
  let manualReason: string | undefined;
  if (c.manualReason !== undefined) {
    if (typeof c.manualReason !== "string" || c.manualReason.trim() === "") {
      throw new VerificationContractError("manualReason must be non-empty string when present");
    }
    manualReason = c.manualReason.trim();
  }
  if (checks.length === 0 && !manualReason) {
    throw new VerificationContractError(
      "contract must have at least one check OR a non-empty manualReason",
    );
  }
  return { checks, manualReason };
}

/**
 * Validate that every check references a known primary/target repo and that
 * the repo's worktree directory is registered.
 */
export function validateContractAgainstRepos(
  contract: VerificationContract,
  manifest: TaskManifestV2,
  requireWorktree = false,
): { ok: true } | { ok: false; reason: string } {
  for (const c of contract.checks) {
    const repo = manifest.repos[c.repo];
    if (!repo) return { ok: false, reason: `check "${c.id}": repo "${c.repo}" not registered` };
    if (repo.role === "reference") {
      return { ok: false, reason: `check "${c.id}": repo "${c.repo}" has role reference (verification only allowed for primary/target)` };
    }
    if (requireWorktree && !repo.worktreePath) {
      return { ok: false, reason: `check "${c.id}": repo "${c.repo}" has no worktree recorded` };
    }
  }
  return { ok: true };
}

export interface RunContractOptions {
  /**
   * Maximum captured stdout/stderr per check, in bytes. Defaults to 4096.
   * The captured tail is what `task_submit` returns to the implementer.
   */
  tailBytes?: number;
}

/**
 * Run all checks of a contract sequentially, in declared order. The shell
 * is `sh -c <command>` so the user can use project-specific variables; the
 * captured `tail` keeps the failure summary bounded.
 */
export async function runContract(
  exec: ExecFn,
  contract: VerificationContract,
  manifest: TaskManifestV2,
  opts: RunContractOptions = {},
): Promise<VerificationRunResult> {
  const tailBytes = opts.tailBytes ?? TAIL_BYTES;
  const startedAt = new Date().toISOString();
  const outcomes: CheckOutcome[] = [];
  const requiredFailures: string[] = [];
  const optionalFailures: string[] = [];

  for (const check of contract.checks) {
    const repo = manifest.repos[check.repo];
    if (!repo || !repo.worktreePath) {
      // Defensive — validateContractAgainstRepos should have caught this.
      const out: CheckOutcome = {
        id: check.id,
        command: check.command,
        repo: check.repo,
        required: check.required,
        status: "error",
        exitCode: null,
        durationMs: 0,
        stdoutTail: "",
        stderrTail: "",
        error: `repo "${check.repo}" has no worktree`,
      };
      outcomes.push(out);
      (check.required ? requiredFailures : optionalFailures).push(check.id);
      continue;
    }

    const t0 = performance.now();
    const res = await exec("sh", ["-c", check.command], {
      cwd: repo.worktreePath,
      signal: AbortSignal.timeout(HARD_TIMEOUT_MS),
    });
    const durationMs = Math.round(performance.now() - t0);
    const status: CheckOutcome["status"] =
      res.code === 0 ? "pass" : res.code === null ? "error" : "fail";
    const outcome: CheckOutcome = {
      id: check.id,
      command: check.command,
      repo: check.repo,
      required: check.required,
      status,
      exitCode: res.code,
      durationMs,
      stdoutTail: tail(res.stdout, tailBytes),
      stderrTail: tail(res.stderr, tailBytes),
    };
    outcomes.push(outcome);
    if (status !== "pass") {
      (check.required ? requiredFailures : optionalFailures).push(check.id);
    }
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    requiredFailures,
    optionalFailures,
    outcomes,
    manualOnly: contract.checks.length === 0 && !!contract.manualReason,
  };
}

function tail(s: string, n: number): string {
  if (s.length <= n) return s;
  return `…[truncated ${s.length - n} bytes]…\n${s.slice(-n)}`;
}

/**
 * Convenience: load contract, validate against manifest, return parsed
 * contract (or throw on validation failure).
 */
export function loadAndValidateContract(
  taskId: string,
  manifest: TaskManifestV2,
): VerificationContract {
  const contract = readVerificationContract(taskId);
  const v = validateContractAgainstRepos(contract, manifest, true);
  if (!v.ok) throw new VerificationContractError(v.reason);
  return contract;
}

/**
 * Build the path where a check should run. The spec says checks run in the
 * registered repo's worktree; this helper exposes the same path the
 * contract should be referencing implicitly.
 */
export function checkCwd(manifest: TaskManifestV2, repoName: string): string {
  const repo = manifest.repos[repoName];
  if (!repo || !repo.worktreePath) {
    throw new VerificationContractError(`repo "${repoName}" has no worktree`);
  }
  return resolve(repo.worktreePath);
}

// re-exports for test ergonomics
export { specPath, worktreePath };
