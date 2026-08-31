import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createManifest, MANIFEST_FILE } from "./manifest.ts";

const root = resolve(process.env.TCSF_BUNDLE_ROOT ?? process.argv[2] ?? ".");
await mkdir(root, { recursive: true });
const manifest = await createManifest(root);
const path = join(root, MANIFEST_FILE);
await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ path, algorithm: manifest.algorithm, files: manifest.files.length, treeHash: manifest.treeHash }));
