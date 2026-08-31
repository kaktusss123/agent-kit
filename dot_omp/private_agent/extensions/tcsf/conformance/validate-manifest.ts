import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MANIFEST_FILE, type Manifest, validateManifest } from "./manifest.ts";

const root = resolve(process.env.TCSF_BUNDLE_ROOT ?? process.argv[2] ?? ".");
const manifestPath = resolve(process.env.TCSF_MANIFEST_PATH ?? process.argv[3] ?? join(root, MANIFEST_FILE));
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
const errors = await validateManifest(root, manifest);
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(JSON.stringify({ root, manifestPath, algorithm: manifest.algorithm, files: manifest.files.length, treeHash: manifest.treeHash }));
