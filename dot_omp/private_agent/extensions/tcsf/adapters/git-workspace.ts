import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import type { GitExec } from "./git-exec.ts";
import { createGitExec, GitExecError } from "./git-exec.ts";
import type { ChangeSet, PrepareWorkspacesInput, RepoChanges, RepoInspection, RepositoryRole, RestoreResult, RestoreUnauthorizedInput, Workspace, WorkspacePort, WorkspaceSet } from "../ports/workspace.ts";
import { WorkspaceValidationError } from "../ports/workspace.ts";

function contained(root: string, child: string): boolean { const r = resolve(root); const c = resolve(child); return c === r || c.startsWith(`${r}${sep}`); }
function repoKey(path: string): string { return createHash("sha256").update(path).digest("hex").slice(0, 16); }
function parseStatus(output: string): string[] { return output.split("\0").filter(Boolean).map(item => item.length > 3 ? item.slice(3) : item); }
function fingerprint(head: string, branch: string, status: string): string { return createHash("sha256").update(`${head}\0${branch}\0${status}`).digest("hex"); }
function normalPath(file: string): string { return file.replaceAll("\\", "/"); }
function matchesScope(file: string, scope: readonly string[] | undefined): boolean {
  const normalizedFile = normalPath(file); if (!normalizedFile || normalizedFile.includes("\0") || normalizedFile.startsWith("/") || normalizedFile.split("/").includes("..")) return false;
  return (scope ?? []).some(pattern => { const normalized = normalPath(pattern); if (normalized === "*") return true; if (normalized.endsWith("/**")) { const base = normalized.slice(0, -3).replace(/\/$/u, ""); return normalizedFile === base || normalizedFile.startsWith(`${base}/`); } if (normalized.startsWith("*.")) return normalizedFile.split("/").at(-1)?.endsWith(normalized.slice(1)) ?? false; return normalizedFile === normalized; });
}

export class GitWorkspace implements WorkspacePort {
  constructor(private readonly git: GitExec = createGitExec()) {}
  async inspectRepo(path: string, role: RepositoryRole = "primary"): Promise<RepoInspection> {
    const rootResult = await this.git.exec(["-C", path, "rev-parse", "--show-toplevel"], path);
    const canonicalRoot = realpathSync(rootResult.stdout);
    const headSha = (await this.git.exec(["rev-parse", "HEAD"], canonicalRoot)).stdout;
    const branchResult = await this.git.exec(["symbolic-ref", "--short", "-q", "HEAD"], canonicalRoot, { throwOnError: false }); const branch = branchResult.stdout || "(detached)";
    const statusRaw = (await this.git.exec(["status", "--porcelain=v1", "-z"], canonicalRoot)).stdout;
    const trackedFiles = (await this.git.exec(["ls-files"], canonicalRoot)).stdout.split("\n").filter(Boolean);
    const untrackedFiles = parseStatus(statusRaw).filter((_, index) => statusRaw.split("\0").filter(Boolean)[index]?.startsWith("??"));
    return { canonicalRoot, headSha, fingerprint: fingerprint(headSha, branch, statusRaw), isClean: statusRaw.length === 0, trackedFiles, untrackedFiles, stagedChanges: parseStatus(statusRaw), role };
  }
  async prepareTaskWorkspaces(input: PrepareWorkspacesInput): Promise<WorkspaceSet> {
    const workspaces = new Map<string, Workspace>(); const canonicalPaths = new Set<string>(); const keys = new Set<string>();
    await mkdir(input.worktreesDir, { recursive: true });
    for (const repo of input.repositories) {
      const inspection = await this.inspectRepo(repo.canonicalPath, repo.role);
      if (!inspection.isClean) throw new WorkspaceValidationError(`repository is dirty: ${inspection.canonicalRoot}`, "dirty_working_tree");
      if (inspection.headSha !== repo.baseSha) throw new WorkspaceValidationError(`base SHA mismatch for ${repo.canonicalPath}`, "base_sha_mismatch");
      const key = repo.repoKey || repoKey(inspection.canonicalRoot);
      if (keys.has(key)) throw new WorkspaceValidationError(`duplicate repo key: ${key}`, "repo_collision");
      if (canonicalPaths.has(inspection.canonicalRoot)) throw new WorkspaceValidationError(`duplicate repository path: ${inspection.canonicalRoot}`, "duplicate_path");
      keys.add(key); canonicalPaths.add(inspection.canonicalRoot);
      if (repo.role === "reference") { workspaces.set(key, { role: repo.role, canonicalPath: inspection.canonicalRoot, baseSha: repo.baseSha, repoKey: key, isWorktree: false, writableScope: repo.writableScope, fingerprint: inspection.fingerprint }); continue; }
      const worktreePath = resolve(input.worktreesDir, key);
      if (!contained(input.worktreesDir, worktreePath)) throw new WorkspaceValidationError("worktree path escapes task root", "path_traversal_detected");
      if (!existsSync(worktreePath)) {
        try { await this.git.exec(["-C", inspection.canonicalRoot, "worktree", "add", "--detach", worktreePath, repo.baseSha], inspection.canonicalRoot); }
        catch (error) { throw new WorkspaceValidationError(`worktree creation failed: ${String(error)}`, "worktree_creation_failed"); }
      }
      const worktreeInspection = await this.inspectRepo(worktreePath, repo.role);
      if (worktreeInspection.headSha !== repo.baseSha) throw new WorkspaceValidationError(`worktree base mismatch: ${worktreePath}`, "base_sha_mismatch");
      workspaces.set(key, { role: repo.role, canonicalPath: inspection.canonicalRoot, baseSha: repo.baseSha, repoKey: key, isWorktree: true, worktreePath, writableScope: repo.writableScope, fingerprint: inspection.fingerprint });
    }
    return { taskId: input.taskId, workspaces, preparedAt: new Date().toISOString() };
  }
  async validateWorkspaceSet(set: WorkspaceSet): Promise<void> {
    const paths = new Set<string>();
    for (const workspace of set.workspaces.values()) {
      if (paths.has(workspace.canonicalPath)) throw new WorkspaceValidationError("duplicate workspace path", "duplicate_path");
      paths.add(workspace.canonicalPath);
      const inspection = await this.inspectRepo(workspace.canonicalPath, workspace.role);
      if (inspection.fingerprint !== workspace.fingerprint) throw new WorkspaceValidationError(`protected repository changed: ${workspace.canonicalPath}`, "protected_fingerprint_mismatch");
    }
  }
  async captureChanges(set: WorkspaceSet): Promise<ChangeSet> {
    const changes = new Map<string, RepoChanges>();
    for (const workspace of set.workspaces.values()) {
      const path = workspace.isWorktree ? workspace.worktreePath! : workspace.canonicalPath;
      const status = (await this.git.exec(["status", "--porcelain=v1", "-z"], path)).stdout;
      const records = status.split("\0").filter(Boolean); const modifiedFiles: string[] = []; const addedFiles: string[] = []; const deletedFiles: string[] = [];
      for (const record of records) { const code = record.slice(0, 2); const file = record.slice(3); if (code.includes("D")) deletedFiles.push(file); else if (code === "??" || code.includes("A")) addedFiles.push(file); else modifiedFiles.push(file); }
      const committedRaw = (await this.git.exec(["diff", "--name-only", "-z", `${workspace.baseSha}..HEAD`], path, { throwOnError: false })).stdout;
      const committedFiles = committedRaw.split("\0").filter(Boolean);
      const changedFiles = [...modifiedFiles, ...addedFiles, ...deletedFiles, ...committedFiles];
      const unauthorizedFiles = workspace.isWorktree ? [...new Set(changedFiles)].filter(file => !matchesScope(file, workspace.writableScope)) : [...new Set(changedFiles)]; const protectedChanged = workspace.isWorktree && (await this.inspectRepo(workspace.canonicalPath, workspace.role)).fingerprint !== workspace.fingerprint; if (protectedChanged) unauthorizedFiles.push("[protected-repository-changed]");
      const diffStat = (await this.git.exec(["diff", "--stat", workspace.baseSha, "--"], path)).stdout;
      changes.set(workspace.repoKey, { repoKey: workspace.repoKey, modifiedFiles, addedFiles, deletedFiles, committedFiles, unauthorizedFiles, diffStat, isAuthorized: unauthorizedFiles.length === 0 });
    }
    return { changes, capturedAt: new Date().toISOString() };
  }
  async restoreUnauthorizedChanges(input: RestoreUnauthorizedInput): Promise<RestoreResult> {
    const results = new Map<string, { repoKey: string; succeeded: boolean; restoredFiles: string[]; strategy: "checkout_ours" | "stash_drop" | "worktree_remove"; error?: string }>();
    for (const key of input.unauthorizedRepos) {
      const workspace = input.workspaceSet.workspaces.get(key); const change = input.changeSet.changes.get(key);
      if (!workspace || !change) { results.set(key, { repoKey: key, succeeded: false, restoredFiles: [], strategy: "checkout_ours", error: "unknown repository" }); continue; }
      if (!workspace.isWorktree) { results.set(key, { repoKey: key, succeeded: false, restoredFiles: [], strategy: "checkout_ours", error: "refusing to restore unauthorized changes in protected repository" }); continue; }
      try {
        const path = workspace.worktreePath!;
        await this.git.exec(["reset", "--hard", workspace.baseSha], path);
        await this.git.exec(["clean", "-fd"], path);
        results.set(key, { repoKey: key, succeeded: true, restoredFiles: change.unauthorizedFiles, strategy: "worktree_remove" });
      } catch (error) { results.set(key, { repoKey: key, succeeded: false, restoredFiles: [], strategy: "worktree_remove", error: String(error) }); }
    }
    return { results, allSucceeded: [...results.values()].every(result => result.succeeded), restoredAt: new Date().toISOString() };
  }
}
export function createGitWorkspace(git?: GitExec): GitWorkspace { return new GitWorkspace(git); }
