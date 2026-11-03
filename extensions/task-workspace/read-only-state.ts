/**
 * Public read-only state contract v1 — the task-workspace source.
 *
 * The contract itself (discovery symbol, registry shape, exact versions,
 * reader algorithm, projection fields, ownership and session rules) is
 * documented in `docs/read-only-state.md`. This module owns Core's task
 * source: the session binding, the selection, the Git reads and the history
 * interpretation all stay inside Core (`./current.ts`), and the source hands a
 * caller the computed projection. A presence marker is not enough, and the
 * consumer never recomputes the selection.
 *
 * Guarantees this module owns:
 * - it publishes a record under the same registered symbol the subagents
 *   source uses, so a consumer discovers both sources without importing Core.
 *   The two slots are independent: neither source's presence or failure
 *   affects the other;
 * - the record carries an exact source version, and a read is either `ok`
 *   (with the computed projection), `unavailable` (no session bound in this
 *   process — before `session_start` or after `session_shutdown`) or `error`.
 *   "No association" is a projection `state: "none"`, not `unavailable`, and
 *   never a fabricated empty workspace;
 * - every read captures the binding that was current when it started and
 *   reports that binding's monotonic session generation, so a result produced
 *   for a previous session can never be presented as the current one after a
 *   session switch or `/reload`;
 * - registration ownership: only the graph that published the current record
 *   may withdraw it, and a new graph's publication wins, so a stale shutdown
 *   cannot remove a newer source;
 * - no transport state, no streams, and no controllable state: this is a
 *   read-only projection.
 *
 * Host-independent: this module is part of the task-workspace core with no pi
 * SDK, no host plumbing and no task-root policy of its own. The extension
 * binding passes the session cwd, the branch-entry getter and the resolved
 * task root in.
 *
 * This directory is loaded as a standalone extension entry by other consumers,
 * so the module keeps its own copy of the shared registry key and of the
 * documented subagents slot contract instead of importing a sibling extension
 * directory. `read-only-state-contract.test.ts` pins the two copies together.
 */
import {
  buildCurrentTaskProjection,
  matchActiveOwners,
  type CurrentOwnerRef,
  type CurrentTaskProjection,
  type SessionSelectionEntry,
} from "./current.ts";

/** Registry symbol shared with `extensions/subagents/read-only-state.ts`. */
export const READ_ONLY_STATE_KEY = Symbol.for("agentkit.read-only-state.v1");
/** Exact registry schema version a reader must see. */
export const READ_ONLY_STATE_SCHEMA_VERSION = 1 as const;
/** Exact task-workspace source version a reader must see. */
export const TASK_WORKSPACE_SOURCE_VERSION = 1 as const;
/** Exact subagents source version this module understands for owner enrichment. */
const SUBAGENTS_SOURCE_VERSION = 1;

/** The live session this process bound; `generation` increases on every bind. */
export interface TaskWorkspaceSession {
  cwd: string;
  /** Read on every projection, so entries appended later in the session count. */
  branchEntries(): SessionSelectionEntry[];
}

/** Session snapshot one read is computed from (the binding at read start). */
export interface TaskWorkspaceProjectionInput extends TaskWorkspaceSession {
  generation: number;
  taskRoot: string;
}

export type TaskWorkspaceReadResult =
  | { status: "ok"; generation: number; projection: CurrentTaskProjection }
  | { status: "unavailable"; reason: "no_session" }
  | { status: "error"; error: { code: string; message: string } };

export interface TaskWorkspaceSourceRecord {
  /** Exact source version; a reader requires equality with its supported one. */
  version: number;
  /** Registration owner token. Readers treat it as opaque and never compare it. */
  owner: unknown;
  /** Generation of the session the source is currently bound to; 0 before the first bind. */
  sessionGeneration(): number;
  read(): Promise<TaskWorkspaceReadResult>;
}

/** The registry as this source sees it. The sibling slot stays opaque here. */
interface ReadOnlyStateRegistry {
  schemaVersion: number;
  subagents?: unknown;
  taskWorkspace?: TaskWorkspaceSourceRecord;
}

type Projector = (input: TaskWorkspaceProjectionInput) => Promise<CurrentTaskProjection>;

const globalScope = globalThis as { [key: symbol]: ReadOnlyStateRegistry | undefined };

/** Identifies this module copy: only the graph that published may withdraw. */
const instanceToken: object = {};

let boundSession: TaskWorkspaceSession | undefined;
let generation = 0;
let taskRoot: string | undefined;
let projector: Projector = projectBoundSession;

function registryForWrite(): ReadOnlyStateRegistry | undefined {
  const existing = globalScope[READ_ONLY_STATE_KEY];
  if (existing === undefined) {
    const created: ReadOnlyStateRegistry = { schemaVersion: READ_ONLY_STATE_SCHEMA_VERSION };
    globalScope[READ_ONLY_STATE_KEY] = created;
    return created;
  }
  if (existing === null || typeof existing !== "object") return undefined;
  return existing.schemaVersion === READ_ONLY_STATE_SCHEMA_VERSION ? existing : undefined;
}

/**
 * Publish this graph's task source. `project` is the projection seam used by
 * the contract tests; production always uses Core's own computation.
 */
export function publishTaskWorkspaceStateSource(opts: {
  taskRoot: string;
  project?: Projector;
}): void {
  const registry = registryForWrite();
  if (!registry) return;
  taskRoot = opts.taskRoot;
  projector = opts.project ?? projectBoundSession;
  registry.taskWorkspace = {
    version: TASK_WORKSPACE_SOURCE_VERSION,
    owner: instanceToken,
    sessionGeneration: () => generation,
    read,
  };
}

/**
 * Withdraw this graph's record on shutdown; a newer graph's record survives.
 * The bound session of this graph is dropped as well, so nothing of the
 * closing session can answer a later read.
 */
export function withdrawTaskWorkspaceStateSource(): void {
  const registry = globalScope[READ_ONLY_STATE_KEY];
  if (registry && registry.taskWorkspace?.owner === instanceToken) {
    registry.taskWorkspace = undefined;
  }
  boundSession = undefined;
}

/**
 * Bind the session a read projects. Called on every `session_start`, which is
 * also the `/reload` and session-switch point; the generation increases, so a
 * result computed for the previous binding is identifiable as stale.
 */
export function bindTaskWorkspaceSession(session: TaskWorkspaceSession): number {
  boundSession = session;
  generation += 1;
  return generation;
}

/** Process has no live session bound (before `session_start`, after shutdown). */
export function clearTaskWorkspaceSession(): void {
  boundSession = undefined;
}

/** Current session generation; 0 when this process never bound a session. */
export function taskWorkspaceSessionGeneration(): number {
  return generation;
}

/** Read the published source exactly as a foreign consumer would. */
function read(): Promise<TaskWorkspaceReadResult> {
  const session = boundSession;
  const root = taskRoot;
  if (!session || root === undefined) {
    return Promise.resolve({ status: "unavailable", reason: "no_session" });
  }
  const input: TaskWorkspaceProjectionInput = {
    cwd: session.cwd,
    branchEntries: session.branchEntries,
    generation,
    taskRoot: root,
  };
  return Promise.resolve()
    .then(() => projector(input))
    .then(
      (projection): TaskWorkspaceReadResult => ({ status: "ok", generation: input.generation, projection }),
      (e): TaskWorkspaceReadResult => ({
        status: "error",
        error: { code: "projection_failed", message: e instanceof Error ? e.message : String(e) },
      }),
    );
}

/** Default projection: Core's own session-scoped current-task computation. */
async function projectBoundSession(input: TaskWorkspaceProjectionInput): Promise<CurrentTaskProjection> {
  return buildCurrentTaskProjection({
    cwd: input.cwd,
    taskRoot: input.taskRoot,
    branchEntries: input.branchEntries(),
    owners: activeWorkspaceOwners,
  });
}

/**
 * Active workspace RepoOwners for one repository path, read through the
 * published subagents source. This is the only cross-source field in the
 * contract: an unavailable or failing subagents source yields no owner refs,
 * and the consumer must read that as unknown owner knowledge, not as "no
 * owner" (see the contract document).
 */
function activeWorkspaceOwners(repoPath: string): CurrentOwnerRef[] {
  const registry = globalScope[READ_ONLY_STATE_KEY];
  if (!registry || registry.schemaVersion !== READ_ONLY_STATE_SCHEMA_VERSION) return [];
  const slot = registry.subagents as { version?: unknown; read?: unknown } | undefined;
  if (!slot || slot.version !== SUBAGENTS_SOURCE_VERSION || typeof slot.read !== "function") return [];
  let result: { status?: unknown; agents?: unknown };
  try {
    result = (slot.read as () => { status?: unknown; agents?: unknown })();
  } catch {
    return [];
  }
  if (result?.status !== "ok") return [];
  return matchActiveOwners(result.agents, repoPath);
}
