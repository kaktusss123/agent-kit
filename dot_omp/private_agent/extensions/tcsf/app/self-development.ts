import type { RepositoryContract } from "../core/types.ts";
const SELF_SCOPE_PREFIXES = [
  "dot_omp/private_agent/extensions/tcsf",
  "dot_omp/private_agent/skills",
  "dot_omp/private_agent/agents",
  "dot_omp/private_agent/runtime",
  "dot_omp/private_agent/config",
];

export function isSelfChange(repositories: readonly RepositoryContract[]): boolean {
  return repositories.some(repository => repository.writableScope?.some(scope => isSelfScope(scope)) === true || isTcsfRepository(repository.canonicalPath));
}

function isSelfScope(scope: string): boolean {
  const normalized = scope.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/\*\*?$/u, "");
  return SELF_SCOPE_PREFIXES.some(prefix => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function isTcsfRepository(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/u, "");
  return normalized.endsWith("/private_agent/extensions/tcsf") || normalized.endsWith("/private_agent/extensions/tcsf-worktree");
}
