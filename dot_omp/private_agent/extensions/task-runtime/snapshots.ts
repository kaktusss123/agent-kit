/**
 * Immutable approval snapshots.
 *
 * `approveTask()` writes spec.md, evidence.md, decisions.jsonl, and
 * verification.json into `snapshots/<approvalId>/` and hashes each copy.
 * After approval, the implementer reads ONLY from the snapshot — mutable
 * `artifacts/` are ignored.
 */

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  decisionsPath,
  evidencePath,
  snapshotDir,
  snapshotDecisionsPath,
  snapshotEvidencePath,
  snapshotHandoffPath,
  snapshotSpecPath,
  snapshotVerificationPath,
  specPath,
  verificationPath,
} from "./paths.ts";
import type {
  ApprovalRecord,
  Sha256Hex,
  TaskManifestV2,
} from "./types.ts";

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

/**
 * Stable, sortable approval id (timestamp + 6 random hex chars).
 */
export function newApprovalId(): string {
  const ts = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  const rnd = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
  return `apr-${ts}-${rnd}`;
}

export async function sha256OfFile(path: string): Promise<Sha256Hex> {
  const f = Bun.file(path);
  if (!(await f.exists())) {
    throw new SnapshotError(`cannot hash missing file: ${path}`);
  }
  const hash = new Bun.CryptoHasher("sha256");
  const stream = f.stream();
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function sha256OfBytes(bytes: Uint8Array): Promise<Sha256Hex> {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(bytes);
  return hash.digest("hex");
}

export interface SnapshotArtifacts {
  specSha256: Sha256Hex;
  evidenceSha256: Sha256Hex;
  decisionsSha256: Sha256Hex;
  verificationSha256: Sha256Hex;
}

/**
 * Build a snapshot from current `artifacts/`. Each file is copied (binary
 * safe) and then the COPY is hashed — not the source — to ensure that
 * future mutations of `artifacts/` do not break implementer validation.
 */
export async function buildSnapshot(
  taskId: string,
  approvalId: string,
): Promise<{ record: ApprovalRecord; artifacts: SnapshotArtifacts }> {
  const snapDir = snapshotDir(taskId, approvalId);
  await mkdir(snapDir, { recursive: true });

  const sources = {
    spec: specPath(taskId),
    evidence: evidencePath(taskId),
    decisions: decisionsPath(taskId),
    verification: verificationPath(taskId),
  };
  for (const [k, p] of Object.entries(sources)) {
    if (!existsSync(p)) {
      throw new SnapshotError(`cannot snapshot: ${k} missing at ${p}`);
    }
  }

  const destSpec = snapshotSpecPath(taskId, approvalId);
  const destEvidence = snapshotEvidencePath(taskId, approvalId);
  const destDecisions = snapshotDecisionsPath(taskId, approvalId);
  const destVerification = snapshotVerificationPath(taskId, approvalId);

  for (const d of [destSpec, destEvidence, destDecisions, destVerification]) {
    await mkdir(dirname(d), { recursive: true });
  }

  // Copy as bytes (file identity preserved, no shell interpolation).
  const specBytes = await Bun.file(sources.spec).bytes();
  const evidenceBytes = await Bun.file(sources.evidence).bytes();
  const decisionsBytes = await Bun.file(sources.decisions).bytes();
  const verificationBytes = await Bun.file(sources.verification).bytes();

  await Bun.write(destSpec, specBytes);
  await Bun.write(destEvidence, evidenceBytes);
  await Bun.write(destDecisions, decisionsBytes);
  await Bun.write(destVerification, verificationBytes);

  // Hash what we just wrote — ensures the snapshot's hash matches the
  // implementation will validate later.
  const artifacts: SnapshotArtifacts = {
    specSha256: await sha256OfBytes(specBytes),
    evidenceSha256: await sha256OfBytes(evidenceBytes),
    decisionsSha256: await sha256OfBytes(decisionsBytes),
    verificationSha256: await sha256OfBytes(verificationBytes),
  };

  // Defensive re-check: hash the file on disk and compare to byte hash.
  const onDisk = {
    specSha256: await sha256OfFile(destSpec),
    evidenceSha256: await sha256OfFile(destEvidence),
    decisionsSha256: await sha256OfFile(destDecisions),
    verificationSha256: await sha256OfFile(destVerification),
  };
  for (const k of Object.keys(artifacts) as (keyof SnapshotArtifacts)[]) {
    if (artifacts[k] !== onDisk[k]) {
      throw new SnapshotError(
        `snapshot hash mismatch on ${k}: byte=${artifacts[k]} on-disk=${onDisk[k]}`,
      );
    }
  }

  const record: ApprovalRecord = {
    id: approvalId,
    createdAt: new Date().toISOString(),
    snapshotPath: resolve(snapDir),
    specSha256: artifacts.specSha256,
    evidenceSha256: artifacts.evidenceSha256,
    decisionsSha256: artifacts.decisionsSha256,
    verificationSha256: artifacts.verificationSha256,
  };
  return { record, artifacts };
}

/**
 * Verify that a snapshot still matches its recorded hashes. Used at
 * handoff time to detect any tampering with the frozen contract.
 */
export async function validateSnapshot(
  taskId: string,
  approval: ApprovalRecord,
): Promise<{ valid: boolean; mismatches: string[] }> {
  const mismatches: string[] = [];
  const pairs: Array<[string, Sha256Hex, string]> = [
    ["spec", approval.specSha256, snapshotSpecPath(taskId, approval.id)],
    ["evidence", approval.evidenceSha256, snapshotEvidencePath(taskId, approval.id)],
    ["decisions", approval.decisionsSha256, snapshotDecisionsPath(taskId, approval.id)],
    ["verification", approval.verificationSha256, snapshotVerificationPath(taskId, approval.id)],
  ];
  for (const [name, expected, p] of pairs) {
    const actual = await sha256OfFile(p).catch(() => "");
    if (actual !== expected) {
      mismatches.push(`${name}: expected ${expected}, got ${actual || "<missing>"}`);
    }
  }
  return { valid: mismatches.length === 0, mismatches };
}

export interface HandoffDoc {
  schemaVersion: 1;
  taskId: string;
  type: TaskManifestV2["type"];
  approvalId: string;
  snapshot: {
    specPath: string;
    evidencePath: string;
    decisionsPath: string;
    verificationPath: string;
  };
  repos: Record<
    string,
    {
      role: "primary" | "target" | "reference";
      sourcePath: string;
      worktreePath?: string;
      baseSha?: string;
    }
  >;
}

/**
 * Write `handoff.json` into the snapshot directory. Pure serializer — does
 * not consult live `artifacts/`. Use this AFTER `buildSnapshot` so the
 * frozen contract and the handoff refer to the same files.
 */
export async function writeHandoff(
  taskId: string,
  approvalId: string,
  doc: Omit<HandoffDoc, "schemaVersion">,
): Promise<void> {
  const full: HandoffDoc = { schemaVersion: 1, ...doc };
  const p = snapshotHandoffPath(taskId, approvalId);
  await mkdir(dirname(p), { recursive: true });
  await Bun.write(p, JSON.stringify(full, null, 2) + "\n");
}

export async function readHandoff(
  taskId: string,
  approvalId: string,
): Promise<HandoffDoc> {
  const p = snapshotHandoffPath(taskId, approvalId);
  const text = await Bun.file(p).text();
  const parsed = JSON.parse(text) as HandoffDoc;
  if (parsed.schemaVersion !== 1) {
    throw new SnapshotError(`handoff.json has unknown schemaVersion ${parsed.schemaVersion}`);
  }
  return parsed;
}
