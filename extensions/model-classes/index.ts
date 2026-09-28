/**
 * model-classes — named model + thinking classes for Pi.
 *
 * Any number of user-named classes (`/model-class <name> set`), plus:
 *
 *   default -> the CURRENT main session model + thinking; never stored,
 *              always a live snapshot taken at resolution time.
 *
 * Commands:
 *
 *   /model-class                                  status + usage;
 *   /model-class <class>                          apply the saved pair to this session;
 *   /model-class <class> set                      persist the current pair into the class;
 *   /model-class <class> unset                    delete the class (refused while routed);
 *   /model-class next                             cycle to the next saved class (stateless);
 *   /model-class route                            show the spawn-mode routing table;
 *   /model-class route <plain|repoOwner> <class|inherit>
 *                                                 set/reset a spawn mode's default.
 *
 * Ctrl+Alt+P cycles classes with the same stateless rule as `next`; the
 * shortcut notifies with the applied class + pair.
 *
 * Switching never leaves a mixed model/thinking state and never falls back
 * (not to default, not to another model, no reasoning downgrade). Storage:
 * `<agent-dir>/model-classes.json`, atomic; classes keep storage insertion
 * order, which is the cycling order.
 *
 * The resolution itself lives in core.ts and is shared with the subagents
 * extension (`subagent spawn modelClass=...` and spawn-mode routing resolve
 * through the same functions before the child process is started).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	applyResolvedPair,
	canonicalModelId,
	createExactModelMatcher,
	nextModelClass,
	resolveModelClass,
	type ModelClassEnv,
	type ModelLike,
	type SessionModelApplier,
} from "./core";
import { parseModelClassCommand, MODEL_CLASS_USAGE } from "./parse";
import {
	renderModelClassStatus,
	renderRouteSet,
	renderRoutingTable,
	renderSaved,
	renderSwitched,
	renderUnset,
} from "./render";
import {
	loadStoredFile,
	modelClassesPath,
	saveModelClass,
	saveRouting,
	unsetModelClass,
	type ModelPair,
	type StoredClasses,
	type StoredModelClasses,
} from "./store";

/** Structural slice of the pi command/shortcut ctx this extension needs. */
interface CtxLike {
	model?: ModelLike | undefined;
	modelRegistry: { getAll(): ModelLike[] };
	ui: { notify(text: string, kind: "info" | "error" | "warning"): void };
}

export default function (pi: ExtensionAPI) {
	/** Registry-backed exact matcher, rebuilt per call (models can refresh). */
	function findModelFn(ctxLike: { modelRegistry: { getAll(): ModelLike[] } }) {
		return createExactModelMatcher(ctxLike.modelRegistry.getAll());
	}

	/** Live session pair, read at resolution time — never cached. */
	function currentPair(ctxLike: { model?: ModelLike | undefined }): ModelPair | null {
		if (!ctxLike.model) return null;
		return { model: canonicalModelId(ctxLike.model), thinking: pi.getThinkingLevel() };
	}

	/** Pi-bound applier used by the switch/cycle flows. */
	const applier: SessionModelApplier = {
		setModel: async (_pair, model) =>
			pi.setModel(model as unknown as Parameters<typeof pi.setModel>[0]),
		setThinkingLevel: (level) => pi.setThinkingLevel(level),
		getThinkingLevel: () => pi.getThinkingLevel(),
	};

	function envFor(ctxLike: { model?: ModelLike | undefined; modelRegistry: { getAll(): ModelLike[] } }): ModelClassEnv {
		return {
			currentPair: () => currentPair(ctxLike),
			findModel: findModelFn(ctxLike),
		};
	}

	function loadStored(): StoredModelClasses {
		return loadStoredFile(modelClassesPath());
	}

	/** Classes-only load for the switch flow and completions. */
	function loadClasses(): StoredClasses {
		return loadStoredFile(modelClassesPath()).classes;
	}

	function notifyError(ctx: CtxLike, prefix: string, e: unknown): void {
		ctx.ui.notify(`${prefix}: ${e instanceof Error ? e.message : String(e)}`, "error");
	}

	/**
	 * Stateless forward cycle (SPEC R5), shared by `/model-class next` and
	 * the Ctrl+Alt+P shortcut: pick the next saved class from the live
	 * session pair, resolve + validate it, and apply it through the shared
	 * no-mixed-state apply path. Any failure leaves the session unchanged.
	 */
	async function cycleToNext(ctx: CtxLike): Promise<void> {
		let stored: StoredModelClasses;
		try {
			stored = loadStored();
		} catch (e) {
			notifyError(ctx, "Cannot cycle", e);
			return;
		}
		const next = nextModelClass(currentPair(ctx), stored.classes);
		if (!next.ok) {
			ctx.ui.notify(next.error, "error");
			return;
		}
		const resolved = resolveModelClass(next.name, stored.classes, envFor(ctx));
		if (!resolved.ok || !resolved.model) {
			ctx.ui.notify(resolved.ok ? "no model resolved in the current session" : resolved.error, "error");
			return;
		}
		const target = { pair: resolved.pair, model: resolved.model };
		const previous = ctx.model
			? { pair: { model: canonicalModelId(ctx.model), thinking: pi.getThinkingLevel() }, model: ctx.model }
			: null;
		const outcome = await applyResolvedPair(applier, target, previous);
		if (!outcome.ok) {
			ctx.ui.notify(outcome.error, "error");
			return;
		}
		ctx.ui.notify(renderSwitched(next.name, target.pair.model, target.pair.thinking), "info");
	}

	pi.registerCommand("model-class", {
		description:
			"Show saved model classes and spawn routing, switch/save/delete classes, cycle classes, or route spawn modes",
		getArgumentCompletions: (prefix: string) => {
			let names: string[] = [];
			try {
				names = Object.keys(loadClasses());
			} catch {
				// unreadable storage: keyword completions only
			}
			const values: string[] = ["next", "route"];
			for (const n of names) values.push(n, `${n} set`, `${n} unset`);
			for (const mode of ["plain", "repoOwner"]) {
				values.push(`route ${mode}`, `route ${mode} inherit`, ...names.map((n) => `route ${mode} ${n}`));
			}
			const items = values.map((v) => ({ value: v, label: v }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const parsed = parseModelClassCommand(args);
			if (parsed.kind === "invalid") {
				ctx.ui.notify(`${parsed.reason}\n\n${MODEL_CLASS_USAGE}`, "error");
				return;
			}

			if (parsed.kind === "status") {
				let stored: StoredModelClasses;
				try {
					stored = loadStored();
				} catch (e) {
					notifyError(ctx, "Cannot read model classes", e);
					return;
				}
				const session = ctx.model
					? { name: "default" as const, model: canonicalModelId(ctx.model), thinking: pi.getThinkingLevel() }
					: { name: "default" as const, model: "(no model in session)" };
				ctx.ui.notify(renderModelClassStatus(session, stored.classes, stored.routing), "info");
				return;
			}

			if (parsed.kind === "next") {
				await cycleToNext(ctx);
				return;
			}

			if (parsed.kind === "routeStatus") {
				let stored: StoredModelClasses;
				try {
					stored = loadStored();
				} catch (e) {
					notifyError(ctx, "Cannot read model classes", e);
					return;
				}
				ctx.ui.notify(renderRoutingTable(stored.classes, stored.routing), "info");
				return;
			}

			if (parsed.kind === "routeSet") {
				const { mode, target } = parsed;
				let stored: StoredModelClasses;
				try {
					stored = loadStored();
				} catch (e) {
					notifyError(ctx, "Cannot read model classes", e);
					return;
				}
				if (target !== "inherit" && stored.classes[target] === undefined) {
					ctx.ui.notify(
						`Model class "${target}" is not saved.\nSave it first: \`/model-class ${target} set\`.`,
						"error",
					);
					return;
				}
				try {
					// Atomic write; throws on failure — only then do we report success.
					saveRouting(modelClassesPath(), mode, target);
				} catch (e) {
					notifyError(ctx, `Cannot route ${mode}`, e);
					return;
				}
				ctx.ui.notify(
					renderRouteSet(mode, target, target === "inherit" ? undefined : stored.classes[target]),
					"info",
				);
				return;
			}

			if (parsed.kind === "set") {
				const pair = currentPair(ctx);
				if (!pair) {
					ctx.ui.notify("Cannot save: no model resolved in the current session.", "error");
					return;
				}
				try {
					// Atomic write; throws on failure — only then do we report success.
					saveModelClass(modelClassesPath(), parsed.name, pair);
				} catch (e) {
					notifyError(ctx, `Cannot save model class "${parsed.name}"`, e);
					return;
				}
				ctx.ui.notify(renderSaved(parsed.name, pair.model, pair.thinking), "info");
				return;
			}

			if (parsed.kind === "unset") {
				let outcome;
				try {
					outcome = unsetModelClass(modelClassesPath(), parsed.name);
				} catch (e) {
					notifyError(ctx, `Cannot delete model class "${parsed.name}"`, e);
					return;
				}
				if (!outcome.ok) {
					ctx.ui.notify(outcome.error, "error");
					return;
				}
				ctx.ui.notify(
					outcome.deleted ? renderUnset(parsed.name) : `Model class "${parsed.name}" is not saved (nothing to delete).`,
					"info",
				);
				return;
			}

			// switch — resolve and validate the whole target combination
			// BEFORE touching the session; any failure leaves it unchanged.
			// The resolver returns the matched registry model, so there is no
			// second lookup to race with a registry refresh.
			let stored: StoredClasses;
			try {
				stored = loadClasses();
			} catch (e) {
				notifyError(ctx, "Cannot switch", e);
				return;
			}
			const resolved = resolveModelClass(parsed.name, stored, envFor(ctx));
			if (!resolved.ok || !resolved.model) {
				ctx.ui.notify(resolved.ok ? "no model resolved in the current session" : resolved.error, "error");
				return;
			}
			const target = { pair: resolved.pair, model: resolved.model };
			const previous = ctx.model
				? { pair: { model: canonicalModelId(ctx.model), thinking: pi.getThinkingLevel() }, model: ctx.model }
				: null;
			const outcome = await applyResolvedPair(applier, target, previous);
			if (!outcome.ok) {
				ctx.ui.notify(outcome.error, "error");
				return;
			}
			ctx.ui.notify(renderSwitched(parsed.name, target.pair.model, target.pair.thinking), "info");
		},
	});

	// Stateless class cycling (SPEC R5): forward only, no persisted
	// "active class" — the live model is the only source of truth.
	pi.registerShortcut("ctrl+alt+p", {
		description: "Cycle the session model to the next saved model class",
		handler: async (ctx) => {
			await cycleToNext(ctx);
		},
	});
}
