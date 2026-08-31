/**
 * Decision storage — append-only `decisions.jsonl` replayed into current
 * open/resolved sets. The runtime validates structure only; semantic
 * judgement is the user's job (cracker prompts the user, runtime rejects
 * malformed state).
 */

import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { decisionsPath, snapshotDecisionsPath } from "./paths.ts";
import type {
  DecisionRecord,
  OpenDecision,
  ResolvedDecision,
} from "./types.ts";

export class MalformedDecisionsError extends Error {
  constructor(message: string) {
    super(`decisions log malformed: ${message}`);
    this.name = "MalformedDecisionsError";
  }
}

export class DuplicateDecisionError extends Error {
  constructor(public readonly id: string) {
    super(`decision "${id}" already open`);
    this.name = "DuplicateDecisionError";
  }
}

export class UnknownDecisionError extends Error {
  constructor(public readonly id: string) {
    super(`decision "${id}" is not open`);
    this.name = "UnknownDecisionError";
  }
}

async function readDecisionsFile(path: string): Promise<DecisionRecord[]> {
  if (!existsSync(path)) return [];
  const text = await Bun.file(path).text();
  const records: DecisionRecord[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new MalformedDecisionsError(`line ${i + 1}: ${(e as Error).message}`);
    }
    validateDecisionRecordShape(parsed, i + 1);
    records.push(parsed as DecisionRecord);
  }
  return records;
}

function validateDecisionRecordShape(rec: unknown, line: number): void {
  if (!rec || typeof rec !== "object") {
    throw new MalformedDecisionsError(`line ${line}: not an object`);
  }
  const r = rec as { op?: unknown; id?: unknown };
  if (r.op !== "open" && r.op !== "resolve") {
    throw new MalformedDecisionsError(`line ${line}: op must be "open" or "resolve"`);
  }
  if (typeof r.id !== "string" || r.id.length === 0) {
    throw new MalformedDecisionsError(`line ${line}: id must be a non-empty string`);
  }
  if (r.op === "open") {
    const o = rec as { question?: unknown; options?: unknown; dependsOn?: unknown };
    if (typeof o.question !== "string" || o.question.length === 0) {
      throw new MalformedDecisionsError(`line ${line}: open record missing question`);
    }
    if (!Array.isArray(o.options) || o.options.length === 0) {
      throw new MalformedDecisionsError(`line ${line}: open record must have options[]`);
    }
    if (o.options.some(x => typeof x !== "string")) {
      throw new MalformedDecisionsError(`line ${line}: options must be strings`);
    }
    if (!Array.isArray(o.dependsOn) || o.dependsOn.some(x => typeof x !== "string")) {
      throw new MalformedDecisionsError(`line ${line}: dependsOn must be string[]`);
    }
  } else {
    const r2 = rec as { answer?: unknown; source?: unknown };
    if (typeof r2.answer !== "string" || r2.answer.length === 0) {
      throw new MalformedDecisionsError(`line ${line}: resolve record missing answer`);
    }
    if (r2.source !== "user" && r2.source !== "system") {
      throw new MalformedDecisionsError(`line ${line}: resolve record source must be user|system`);
    }
  }
}

export async function readDecisions(taskId: string): Promise<DecisionRecord[]> {
  return readDecisionsFile(decisionsPath(taskId));
}

export async function readSnapshotDecisions(
  taskId: string,
  approvalId: string,
): Promise<DecisionRecord[]> {
  return readDecisionsFile(snapshotDecisionsPath(taskId, approvalId));
}

/**
 * Replay records into current open/resolved state. Throws on malformed
 * sequences (e.g. resolving an unknown id, resolving an already-resolved id).
 */
export function replay(records: DecisionRecord[]): {
  open: Map<string, OpenDecision>;
  resolved: Map<string, ResolvedDecision>;
} {
  const open = new Map<string, OpenDecision>();
  const resolved = new Map<string, ResolvedDecision>();
  for (const rec of records) {
    if (rec.op === "open") {
      if (resolved.has(rec.id)) {
        throw new MalformedDecisionsError(
          `decision "${rec.id}" reopened after resolve`,
        );
      }
      if (open.has(rec.id)) {
        throw new MalformedDecisionsError(`decision "${rec.id}" opened twice`);
      }
      open.set(rec.id, {
        id: rec.id,
        question: rec.question,
        dependsOn: [...rec.dependsOn],
        options: [...rec.options],
        recommendation: rec.recommendation,
        reason: rec.reason,
        openedAt: rec.at,
      });
    } else {
      const openRec = open.get(rec.id);
      if (!openRec) {
        throw new MalformedDecisionsError(`resolve for unknown decision "${rec.id}"`);
      }
      open.delete(rec.id);
      resolved.set(rec.id, {
        id: rec.id,
        answer: rec.answer,
        source: rec.source,
        resolvedAt: rec.at,
        question: openRec.question,
      });
    }
  }
  return { open, resolved };
}

export async function snapshotOpenAndResolved(taskId: string, approvalId: string): Promise<{
  open: Map<string, OpenDecision>;
  resolved: Map<string, ResolvedDecision>;
}> {
  const records = await readSnapshotDecisions(taskId, approvalId);
  return replay(records);
}

export async function getOpenDecisions(taskId: string): Promise<OpenDecision[]> {
  const records = await readDecisions(taskId);
  return [...replay(records).open.values()];
}

export async function getResolvedDecisions(taskId: string): Promise<ResolvedDecision[]> {
  const records = await readDecisions(taskId);
  return [...replay(records).resolved.values()];
}

/**
 * Append a new open record. Returns true if accepted, false if the id was
 * already open (caller may treat this as a no-op rather than an error).
 */
export async function appendOpen(
  taskId: string,
  rec: Omit<Extract<DecisionRecord, { op: "open" }>, "op" | "at">,
): Promise<void> {
  const records = await readDecisions(taskId);
  const { open } = replay(records);
  if (open.has(rec.id)) throw new DuplicateDecisionError(rec.id);
  const full: DecisionRecord = {
    op: "open",
    at: new Date().toISOString(),
    ...rec,
  };
  await appendFile(decisionsPath(taskId), JSON.stringify(full) + "\n");
}

export async function appendResolve(
  taskId: string,
  rec: Omit<Extract<DecisionRecord, { op: "resolve" }>, "op" | "at">,
): Promise<void> {
  // Spec §15.3 / §34.3: resolve requires a non-empty answer. Validate
  // BEFORE touching the log so the failure is immediate and visible to
  // the caller, not deferred to the next replay.
  if (typeof rec.answer !== "string" || rec.answer.length === 0) {
    throw new Error('decision.resolve requires a non-empty answer');
  }
  if (rec.source !== "user" && rec.source !== "system") {
    throw new Error('decision.resolve source must be "user" or "system"');
  }
  const records = await readDecisions(taskId);
  const { open } = replay(records);
  if (!open.has(rec.id)) throw new UnknownDecisionError(rec.id);
  const full: DecisionRecord = {
    op: "resolve",
    at: new Date().toISOString(),
    ...rec,
  };
  await appendFile(decisionsPath(taskId), JSON.stringify(full) + "\n");
}
