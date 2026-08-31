import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ApprovedContractPacket, HashedInputArtifact } from "../core/types.ts";
import type { ContractArtifactKey, ContractImporter, FrozenContractArtifact, FrozenContractImport } from "../ports/contract-import.ts";

const ARTIFACT_KEYS: readonly ContractArtifactKey[] = ["spec", "evidence", "decisions", "verification"];

function within(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}

function digest(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function manifestBytes(importedAt: string, artifacts: readonly Omit<FrozenContractArtifact, "bytes">[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, importedAt, artifacts }));
}

export class FsContractImporter implements ContractImporter {
  async import(packet: ApprovedContractPacket, sourceRoot = process.cwd()): Promise<FrozenContractImport> {
    const root = await realpath(resolve(sourceRoot));
    const importedAt = new Date().toISOString();
    const artifacts: FrozenContractArtifact[] = [];
    for (const key of ARTIFACT_KEYS) {
      const artifact = packet.artifacts[key];
      if (!artifact) continue;
      const sourcePath = await this.resolveSource(root, artifact);
      const bytes = new Uint8Array(await readFile(sourcePath));
      const actualHash = digest(bytes);
      if (bytes.byteLength !== artifact.size) throw new Error(`contract artifact ${key} has wrong size`);
      if (actualHash !== artifact.sha256) throw new Error(`contract artifact ${key} has wrong sha256`);
      artifacts.push({ key, sourcePath, copiedPath: `contract/${key === "spec" ? "spec.md" : key === "verification" ? "verification.json" : `${key}.jsonl`}`, size: bytes.byteLength, sha256: actualHash, bytes });
    }
    const manifest = artifacts.map(({ bytes: _bytes, ...artifact }) => artifact);
    const snapshotSha256 = digest(new Uint8Array([...manifestBytes(importedAt, manifest), ...artifacts.flatMap(artifact => [...artifact.bytes])]));
    return { importedAt, artifacts, snapshotSha256 };
  }

  private async resolveSource(root: string, artifact: HashedInputArtifact): Promise<string> {
    if (!artifact.path || artifact.path.includes("\0") || artifact.path.split(/[\\/]/u).includes("..")) throw new Error("contract artifact path escapes permitted import root");
    const candidate = resolve(root, artifact.path);
    if (!within(root, candidate)) throw new Error("contract artifact path escapes permitted import root");
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) throw new Error("contract artifact source may not be a symlink");
    const actual = await realpath(candidate);
    if (!within(root, actual)) throw new Error("contract artifact symlink escapes permitted import root");
    return actual;
  }
}
