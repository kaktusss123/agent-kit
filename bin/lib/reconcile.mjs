// Reconciliation of the recorded ownership against the real filesystem.
//
// Link and delete decisions are made only for paths in the ownership state, and
// only while the target is still exactly the symlink agent-kit created
// (readlink equals the recorded source). Everything else — a foreign symlink, a
// real file, a link the user redirected — is reported and never touched.
//
// The desired set is validated before the first change, and the new state is
// written once at the end, so an interrupted run leaves the previous record
// rather than a claim about a link that was never created.

import { mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { desiredEntities, validateEntity } from "./entities.mjs";
import { lstatOrNull, msg, readlinkOrNull, statOrNull, warn } from "./io.mjs";
import { HOSTS, hostList } from "./paths.mjs";
import {
	loadCommandRecord,
	loadLinkState,
	loadSelection,
	saveCommandRecord,
	saveLinkState,
	saveSelection,
} from "./state.mjs";

function mentions(entries, rel) {
	return entries.some((entry) => entry.rel === rel);
}

export function reconcile(context) {
	const desired = desiredEntities(context.host, context.repo);
	for (const entity of desired) validateEntity(context.repo, entity);

	const owned = loadLinkState(context.stateFile);

	if (desired.length === 0 && owned.length === 0) {
		msg("  nothing to install (no installable content in this repository)");
		return 0;
	}

	let conflicts = 0;
	let created = 0;
	let updated = 0;
	let kept = 0;
	let pruned = 0;
	const stillDesired = [];

	// Pass 1: state entries the repository no longer wants.
	for (const entry of owned) {
		const dst = join(context.root, entry.rel);
		if (desired.some((entity) => entity.rel === entry.rel)) {
			stillDesired.push(entry);
			continue;
		}
		const link = lstatOrNull(dst);
		if (!link) {
			msg(`  prune   ${entry.rel} (target already gone)`);
		} else if (link.isSymbolicLink() && readlinkOrNull(dst) === entry.src) {
			rmSync(dst);
			msg(`  remove  ${entry.rel} (no longer in agent-kit)`);
		} else {
			msg(
				`  forget  ${entry.rel} (no longer in agent-kit; target was changed externally, left untouched)`,
			);
		}
		pruned += 1;
	}

	// Pass 2: every desired entity.
	const final = [];
	for (const entry of desired) {
		const dst = join(context.root, entry.rel);
		mkdirSync(dirname(dst), { recursive: true });
		const link = lstatOrNull(dst);
		if (link?.isSymbolicLink()) {
			const cur = readlinkOrNull(dst);
			const recorded = stillDesired.find((ownedEntry) => ownedEntry.rel === entry.rel);
			if (cur === entry.src) {
				final.push(entry);
				kept += 1;
				continue;
			}
			if (recorded && cur === recorded.src) {
				// Still where agent-kit last put it: safe to repoint at this
				// checkout. The replacement is a rename over the old link, so the
				// path never disappears.
				const tmp = `${dst}.agent-kit-relink-${process.pid}`;
				rmSync(tmp, { force: true });
				symlinkSync(entry.src, tmp);
				renameSync(tmp, dst);
				final.push(entry);
				msg(`  relink  ${entry.rel}`);
				msg(`            was: ${cur}`);
				updated += 1;
				continue;
			}
			conflicts += 1;
			msg(`  conflict ${entry.rel}`);
			msg(`    wants:  ${entry.src}`);
			msg(`    target: ${dst} -> ${cur}`);
			if (mentions(owned, entry.rel)) {
				msg(
					"    this link was redirected manually; agent-kit released ownership and left it untouched.",
				);
			} else {
				msg("    unmanaged symlink; agent-kit never replaces links it does not own.");
			}
			continue;
		}
		if (link) {
			conflicts += 1;
			msg(`  conflict ${entry.rel}`);
			msg(`    wants:  ${entry.src}`);
			msg(`    target: ${dst} exists and is not a symlink`);
			if (mentions(owned, entry.rel)) {
				msg(
					"    a managed link was replaced by a real file; agent-kit released ownership and left it untouched.",
				);
			} else {
				msg("    agent-kit never overwrites real files or directories.");
			}
			continue;
		}
		symlinkSync(entry.src, dst);
		final.push(entry);
		msg(`  link    ${entry.rel}`);
		created += 1;
	}

	saveLinkState(context.stateFile, final);

	msg(
		`  ${created + updated + kept} entity(ies) — ${created} created, ${updated} relinked, ${kept} up to date; ${pruned} pruned`,
	);
	if (conflicts > 0) {
		msg(`  ${conflicts} conflict(s) — conflicting targets were not touched`);
		return 1;
	}
	return 0;
}

export function uninstall(context) {
	const owned = loadLinkState(context.stateFile);
	let removed = 0;
	let released = 0;

	for (const entry of owned) {
		const dst = join(context.root, entry.rel);
		const link = lstatOrNull(dst);
		if (link?.isSymbolicLink() && readlinkOrNull(dst) === entry.src) {
			rmSync(dst);
			msg(`  removed  ${entry.rel}`);
			removed += 1;
		} else if (!link) {
			msg(`  gone     ${entry.rel}`);
		} else {
			msg(`  released ${entry.rel} (target changed externally; left untouched)`);
			released += 1;
		}
	}

	saveLinkState(context.stateFile, []);

	if (removed === 0 && released === 0) {
		msg("  no owned links");
	} else {
		msg(`  removed ${removed} link(s), released ${released} (ownership forgotten)`);
	}
}

export function status(context, note = "") {
	const desired = desiredEntities(context.host, context.repo);
	const owned = loadLinkState(context.stateFile);

	let uptodate = 0;
	let stale = 0;
	let missing = 0;
	let foreign = 0;
	for (const entry of owned) {
		const dst = join(context.root, entry.rel);
		const link = lstatOrNull(dst);
		if (!link?.isSymbolicLink()) {
			missing += 1;
			continue;
		}
		const cur = readlinkOrNull(dst);
		if (desired.some((entity) => entity.rel === entry.rel && entity.src === cur)) {
			uptodate += 1;
		} else if (cur === entry.src) {
			stale += 1;
		} else {
			foreign += 1;
		}
	}

	const suffix = note ? ` (${note})` : "";
	msg(`  ${context.host} root: ${context.root}${suffix}`);
	msg(`    repository wants ${desired.length} entity(ies)`);
	msg(
		`    state: ${owned.length} managed — ${uptodate} up to date, ${stale} relink needed, ${missing} missing, ${foreign} redirected`,
	);
	msg(`    state file: ${context.stateFile}`);
}

export function statusAll(paths) {
	const selection = loadSelection(paths);
	const selected = selection.hosts.length > 0 ? selection.hosts : HOSTS;
	let label;
	if (selection.hosts.length === 0) {
		label = "default: nothing selected yet, a bare install installs every host";
	} else if (selection.source === "recorded") {
		label = `recorded in ${paths.selectionFile}`;
	} else {
		label = "derived from existing links; recorded on the next install";
	}
	msg(`hosts: ${selected.join(" ")} (${label})`);

	for (const host of HOSTS) {
		status(paths.hostContext(host), selected.includes(host) ? "" : "not selected");
	}

	const record = loadCommandRecord(paths.commandFile);
	msg("");
	const launcherLink = lstatOrNull(paths.launcher);
	if (launcherLink?.isSymbolicLink() && record.dst === paths.launcher) {
		msg(`command: ${paths.launcher} -> ${readlinkOrNull(paths.launcher)}`);
	} else if (launcherLink) {
		msg(`command: ${paths.launcher} (present, not managed by agent-kit)`);
	} else {
		msg(`command: not bootstrapped (${paths.launcher})`);
	}
}

// The launcher is owned through its own record, so a reinstall from another
// checkout repoints only a link agent-kit provably put there. A link that
// already points at this checkout is adopted without being touched.
export function bootstrapSelf(paths) {
	const target = join(paths.repo, "bin", "agent-kit");
	if (statOrNull(target)?.isFile() !== true) {
		warn(`no launcher at ${target}; command bootstrap skipped`);
		return;
	}
	const record = loadCommandRecord(paths.commandFile);
	mkdirSync(dirname(paths.launcher), { recursive: true });

	const link = lstatOrNull(paths.launcher);
	if (link?.isSymbolicLink()) {
		const cur = readlinkOrNull(paths.launcher);
		if (cur === target) {
			if (record.dst !== paths.launcher || record.src !== target) {
				saveCommandRecord(paths.commandFile, paths.launcher, target);
			}
			return;
		}
		if (record.dst === paths.launcher && cur === record.src) {
			const tmp = `${paths.launcher}.agent-kit-relink-${process.pid}`;
			rmSync(tmp, { force: true });
			symlinkSync(target, tmp);
			renameSync(tmp, paths.launcher);
			saveCommandRecord(paths.commandFile, paths.launcher, target);
			msg(`  command ${paths.launcher}`);
			msg(`            was: ${cur}`);
			return;
		}
		if (record.dst === paths.launcher) saveCommandRecord(paths.commandFile);
		warn(`${paths.launcher} -> ${cur} is not managed by agent-kit; command bootstrap skipped`);
		return;
	}
	if (link) {
		if (record.dst === paths.launcher) saveCommandRecord(paths.commandFile);
		warn(`${paths.launcher} exists and is not a symlink; command bootstrap skipped`);
		return;
	}
	symlinkSync(target, paths.launcher);
	saveCommandRecord(paths.commandFile, paths.launcher, target);
	msg(`  command ${paths.launcher} -> ${target}`);
}

export function installHosts(paths, namedHosts) {
	const selection = loadSelection(paths);
	let selected = hostList([...selection.hosts, ...namedHosts]);
	// Nothing selected — a fresh machine, or one whose hosts were all removed
	// one by one — means "nothing chosen yet": install every host.
	if (selected.length === 0) selected = [...HOSTS];

	let rc = 0;
	for (const host of HOSTS) {
		if (!selected.includes(host)) {
			msg(`Skipping ${host} (not selected; 'agent-kit install ${host}' adds it)`);
			continue;
		}
		const context = paths.hostContext(host);
		msg(`Installing (${host} root: ${context.root}):`);
		if (reconcile(context) !== 0) rc = 1;
	}
	saveSelection(paths, selected);
	bootstrapSelf(paths);
	return rc;
}

export function uninstallHosts(paths, namedHosts) {
	// Read the selection before uninstalling: without a selection file it is
	// derived from the link state that uninstall is about to empty.
	const selection = loadSelection(paths);
	const targets = namedHosts.length > 0 ? hostList(namedHosts) : [...HOSTS];

	for (const host of HOSTS) {
		if (!targets.includes(host)) continue;
		const context = paths.hostContext(host);
		msg(`Uninstalling (${host} root: ${context.root}):`);
		uninstall(context);
	}

	if (namedHosts.length === 0) {
		rmSync(paths.selectionFile, { force: true });
		return;
	}
	saveSelection(
		paths,
		selection.hosts.filter((host) => !targets.includes(host)),
	);
}

