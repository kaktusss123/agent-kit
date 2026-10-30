// Ownership state: which links agent-kit installed, which hosts are selected,
// and which launcher it bootstrapped.
//
// Link state is one line per managed link, "<dest-rel>\t<source>", relative to
// the host root. Every line is validated before it can influence a filesystem
// decision: exactly two fields, a destination without traversal and an absolute
// source. Invalid lines are dropped with a warning, so a corrupt state file can
// only shrink what agent-kit is allowed to touch.
//
// The host selection lives in its own file, one host per line. Without that
// file (installs made before host selection existed) the selection is derived
// from the link state: every host whose file holds at least one valid row.

import { readFileSync } from "node:fs";
import { warn, writeFileAtomic } from "./io.mjs";
import { HOSTS, hostList, isKnownHost, isSafeRel, isSafeSource } from "./paths.mjs";

function readLines(file) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return null;
	}
	const lines = text.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

export function parseLinkState(text) {
	const own = [];
	for (const line of text.split("\n")) {
		if (line === "") continue;
		const fields = line.split("\t");
		if (fields.length !== 2) {
			warn(`ignoring invalid state line: ${line}`);
			continue;
		}
		const [rel, src] = fields;
		if (!isSafeRel(rel) || !isSafeSource(src)) {
			warn(`ignoring invalid state line: ${line}`);
			continue;
		}
		own.push({ rel, src });
	}
	return own;
}

export function loadLinkState(file) {
	const lines = readLines(file);
	if (lines === null) return [];
	return parseLinkState(lines.join("\n"));
}

export function saveLinkState(file, entries) {
	const content = entries.map(({ rel, src }) => `${rel}\t${src}\n`).join("");
	writeFileAtomic(file, content);
}

export function parseSelection(text) {
	const hosts = [];
	for (const line of text.split("\n")) {
		if (line === "") continue;
		if (!isKnownHost(line)) {
			warn(`ignoring invalid host selection line: ${line}`);
			continue;
		}
		hosts.push(line);
	}
	return hostList(hosts);
}

export function loadSelection(paths) {
	const lines = readLines(paths.selectionFile);
	if (lines !== null) {
		return { hosts: parseSelection(lines.join("\n")), source: "recorded" };
	}
	const derived = HOSTS.filter((host) => loadLinkState(paths.linkStateFile(host)).length > 0);
	return { hosts: derived, source: "derived" };
}

export function saveSelection(paths, hosts) {
	writeFileAtomic(paths.selectionFile, hosts.map((host) => `${host}\n`).join(""));
}

// The launcher record is a single "<dest>\t<source>" row (last valid row wins).
// Both sides must be absolute paths: the record names places outside any host
// root and is used only to recognise the launcher agent-kit itself put there.
export function loadCommandRecord(file) {
	const record = { dst: "", src: "" };
	const lines = readLines(file);
	if (lines === null) return record;
	for (const line of lines) {
		if (line === "") continue;
		const fields = line.split("\t");
		if (fields.length !== 2 || !isSafeSource(fields[0]) || !isSafeSource(fields[1])) {
			warn(`ignoring invalid command state line: ${line}`);
			continue;
		}
		record.dst = fields[0];
		record.src = fields[1];
	}
	return record;
}

export function saveCommandRecord(file, dst, src) {
	if (dst && src) {
		writeFileAtomic(file, `${dst}\t${src}\n`);
		return;
	}
	writeFileAtomic(file, "");
}
