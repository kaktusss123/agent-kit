import { createHash } from "node:crypto";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const MANIFEST_HASH_ALGORITHM = "tcsf-manifest-v1-u64be-path-size-content";
export const MANIFEST_FILE = "FINAL_MANIFEST.json";

export interface ManifestFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly type: "file";
}

export interface Manifest {
  readonly schemaVersion: 1;
  readonly algorithm: string;
  readonly treeHash: string;
  readonly files: readonly ManifestFile[];
}

function normalizedPath(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/");
  if (!value || value.startsWith("../") || value === ".." || value.startsWith("/")) throw new Error(`manifest path escapes root: ${value}`);
  return value;
}

function appendLength(digest: ReturnType<typeof createHash>, value: number): void {
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigUInt64BE(BigInt(value));
  digest.update(bytes);
}

export async function collectManifestFiles(root: string): Promise<ManifestFile[]> {
  const files: ManifestFile[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error(`manifest rejects symlink: ${normalizedPath(root, path)}`);
      if (metadata.isDirectory()) await walk(path);
      else if (metadata.isFile() && normalizedPath(root, path) !== MANIFEST_FILE) {
        const bytes = await readFile(path);
        files.push({ path: normalizedPath(root, path), size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), type: "file" });
      } else if (!metadata.isFile()) throw new Error(`manifest rejects non-regular entry: ${normalizedPath(root, path)}`);
    }
  }
  await walk(root);
  return files.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
}

export async function reproducibleTreeHash(root: string, files?: readonly ManifestFile[]): Promise<string> {
  const digest = createHash("sha256");
  const entries = files ?? await collectManifestFiles(root);
  for (const file of entries) {
    const pathBytes = Buffer.from(file.path, "utf8");
    const bytes = await readFile(join(root, ...file.path.split("/")));
    appendLength(digest, pathBytes.byteLength);
    digest.update(pathBytes);
    appendLength(digest, bytes.byteLength);
    digest.update(bytes);
  }
  return digest.digest("hex");
}

export async function createManifest(root: string): Promise<Manifest> {
  const files = await collectManifestFiles(root);
  return { schemaVersion: 1, algorithm: MANIFEST_HASH_ALGORITHM, treeHash: await reproducibleTreeHash(root, files), files };
}

export async function validateManifest(root: string, manifest: Manifest): Promise<string[]> {
  const errors: string[] = [];
  if (manifest.schemaVersion !== 1) errors.push("unsupported manifest schema");
  if (manifest.algorithm !== MANIFEST_HASH_ALGORITHM) errors.push("manifest algorithm mismatch");
  const actual = await collectManifestFiles(root).catch(error => { errors.push(String(error)); return []; });
  const expected = new Map<string, ManifestFile>();
  for (const file of manifest.files ?? []) {
    if (expected.has(file.path)) errors.push(`duplicate manifest path ${file.path}`);
    expected.set(file.path, file);
  }
  const actualPaths = new Set(actual.map(file => file.path));
  for (const file of actual) if (!expected.has(file.path)) errors.push(`extra file ${file.path}`);
  for (const file of expected.values()) if (!actualPaths.has(file.path)) errors.push(`missing file ${file.path}`);
  for (const file of actual) {
    const expectedFile = expected.get(file.path);
    if (expectedFile && (expectedFile.size !== file.size || expectedFile.sha256 !== file.sha256)) errors.push(`file hash mismatch ${file.path}`);
  }
  if (actual.length === expected.size && await reproducibleTreeHash(root, actual) !== manifest.treeHash) errors.push("manifest tree hash mismatch");
  return errors;
}

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function regularFileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}
