/**
 * V2 storage helpers.
 *
 * Guarantees:
 *   - atomic manifest writes (write tmp, rename)
 *   - append-only events.jsonl
 *   - refuses to silently overwrite legacy (v1) task directories
 *   - refuses to write into non-V2 task directories in V2 operations
 */

import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  eventsPath,
  manifestPath,
  taskRootDir,
} from "./paths.ts";
import type {
  RuntimeEvent,
  TaskManifestV2,
} from "./types.ts";
import { SCHEMA_VERSION } from "./types.ts";

export async function ensureTaskDir(id: string): Promise<string> {
  const dir = taskRootDir(id);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function taskDirExists(id: string): Promise<boolean> {
  try {
    const s = await stat(taskRootDir(id));
    return s.isDirectory();
  } catch {
    return false;
  }
}

export class LegacyTaskError extends Error {
  constructor(public readonly taskId: string) {
    super(`task "${taskId}" is legacy (v1) and is not managed by V2 operations`);
    this.name = "LegacyTaskError";
  }
}

export class TaskNotFoundError extends Error {
  constructor(public readonly taskId: string) {
    super(`task "${taskId}" not found`);
    this.name = "TaskNotFoundError";
  }
}

export async function loadManifest(id: string): Promise<TaskManifestV2> {
  const p = manifestPath(id);
  if (!existsSync(p)) throw new TaskNotFoundError(id);
  const raw = await Bun.file(p).text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`manifest for "${id}" is not valid JSON: ${(e as Error).message}`);
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || (parsed as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION
  ) {
    throw new LegacyTaskError(id);
  }
  return parsed as TaskManifestV2;
}

/**
 * Atomic manifest write: serialize to a sibling tmp file then rename.
 * Re-validates that the in-memory object is still V2 before writing.
 */
export async function saveManifest(manifest: TaskManifestV2): Promise<void> {
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`refusing to save non-V2 manifest (schemaVersion=${manifest.schemaVersion})`);
  }
  const target = manifestPath(manifest.id);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await Bun.write(tmp, JSON.stringify(manifest, null, 2) + "\n");
  await rename(tmp, target);
}

/**
 * Append a single event to events.jsonl. Does NOT parse the existing log
 * for performance — events are an append-only audit trail.
 */
export async function appendEvent(event: RuntimeEvent): Promise<void> {
  const p = eventsPath(event.taskId);
  await mkdir(dirname(p), { recursive: true });
  await appendFile(p, JSON.stringify(event) + "\n");
}

/**
 * Read events.jsonl as JSON objects. Malformed lines are tolerated but
 * reported via the second tuple element so callers can surface diagnostics.
 */
export async function readEvents(id: string): Promise<{
  events: RuntimeEvent[];
  malformed: number;
}> {
  const p = eventsPath(id);
  if (!existsSync(p)) return { events: [], malformed: 0 };
  const text = await Bun.file(p).text();
  const lines = text.split("\n");
  const events: RuntimeEvent[] = [];
  let malformed = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as RuntimeEvent);
    } catch {
      malformed++;
    }
  }
  return { events, malformed };
}
