// One-time migration of the state written by retired multi-runtime installers.
//
// Old rows are "<runtime>\t<dest-rel>\t<source>". Rows of the current host keep
// their ownership in the current two-field format; rows of retired runtimes are
// cleaned up under their historical roots with the ownership proof used
// everywhere else (remove only when the target is still exactly the recorded
// source), then dropped. Rows of unknown runtimes and malformed rows are
// dropped with a warning.
//
// This module is the only place allowed to name retired runtimes or their
// roots. They are cleanup targets, never install targets, and nothing outside
// them may branch on a runtime name.

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { lstatOrNull, msg, readlinkOrNull, warn, writeFileAtomic, statOrNull } from "./io.mjs";
import { isSafeRel, isSafeSource } from "./paths.mjs";

function retiredRoots(home) {
	return {
		// Historical constants of the retired runtimes, kept only so their old
		// links can be released or removed.
		"omp": join(home, ".omp", "agent"),
		"opencode": join(home, ".config", "opencode"),
	};
}

function retireLegacyLink(root, runtime, rel, src) {
	const dst = join(root, rel);
	const link = lstatOrNull(dst);
	if (!link) {
		msg(`  legacy ${runtime}: ${rel} (target already gone)`);
		return;
	}
	if (link.isSymbolicLink() && readlinkOrNull(dst) === src) {
		rmSync(dst);
		msg(`  legacy ${runtime}: removed ${rel} (no longer an agent-kit target)`);
		return;
	}
	msg(`  legacy ${runtime}: released ${rel} (target changed externally, left untouched)`);
}

function isRegularFile(file) {
	return statOrNull(file)?.isFile() === true;
}

export function migrateLegacyState(file, home) {
	if (!isRegularFile(file)) return;
	const roots = retiredRoots(home);
	const kept = [];
	let changed = false;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line === "") continue;
		const fields = line.split("\t");
		if (fields.length < 3) {
			// Current format: kept as-is, validated where it is used.
			kept.push(line);
			continue;
		}
		changed = true;
		const [runtime, rel, src] = fields;
		if (fields.length !== 3 || !isSafeRel(rel) || !isSafeSource(src)) {
			warn(`ignoring invalid state line: ${line}`);
			continue;
		}
		if (runtime === "pi") {
			kept.push(`${rel}\t${src}`);
			continue;
		}
		if (Object.hasOwn(roots, runtime)) {
			retireLegacyLink(roots[runtime], runtime, rel, src);
			continue;
		}
		warn(`ignoring state line for unknown legacy runtime: ${line}`);
	}
	if (changed) writeFileAtomic(file, kept.map((line) => `${line}\n`).join(""));
}
