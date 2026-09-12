/**
 * model-classes — saved model + thinking shortcuts for Pi.
 *
 * Exactly three classes (SPEC):
 *
 *   default -> the CURRENT main session model + thinking; never stored,
 *              always a live snapshot taken at resolution time;
 *   cheap   -> user-saved model + thinking pair;
 *   smart   -> user-saved model + thinking pair.
 *
 * Commands:
 *
 *   /model-class                     status + usage (self-explanatory, no
 *                                    active-class marker: after a switch
 *                                    the applied pair IS the new default);
 *   /model-class <cheap|smart>       apply the saved pair to this session;
 *   /model-class <cheap|smart> set   persist the current pair into the class.
 *
 * `default` is intentionally not addressable: there is no `/model-class
 * default`, no help, no reset. Switching never leaves a mixed model/thinking
 * state and never falls back (not to default, not to another model, no
 * reasoning downgrade). Storage: `<agent-dir>/model-classes.json`, atomic.
 *
 * The resolution itself lives in core.ts and is shared with the subagents
 * extension (`subagent spawn modelClass=...` resolves through the same
 * functions before the child process is started).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	applyResolvedPair,
	canonicalModelId,
	createExactModelMatcher,
	notConfiguredError,
	resolveModelClass,
	type ModelClassEnv,
	type ModelLike,
	type SessionModelApplier,
} from "./core";
import { parseModelClassCommand, MODEL_CLASS_USAGE } from "./parse";
import { renderModelClassStatus, renderSaved, renderSwitched } from "./render";
import { loadModelClasses, modelClassesPath, saveModelClass, type ModelPair, type StoredClasses } from "./store";

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

	/** Pi-bound applier used by the switch flow. */
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

	function loadStored(): StoredClasses {
		return loadModelClasses(modelClassesPath());
	}

	pi.registerCommand("model-class", {
		description: "Show saved model classes (default/cheap/smart), switch, or save the current model",
		getArgumentCompletions: (prefix: string) => {
			const values = ["cheap", "smart", "cheap set", "smart set"];
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
				let stored: StoredClasses;
				try {
					stored = loadStored();
				} catch (e) {
					ctx.ui.notify(`Cannot read model classes: ${e instanceof Error ? e.message : String(e)}`, "error");
					return;
				}
				const session = ctx.model
					? { name: "default" as const, model: canonicalModelId(ctx.model), thinking: pi.getThinkingLevel() }
					: { name: "default" as const, model: "(no model in session)" };
				ctx.ui.notify(renderModelClassStatus(session, stored), "info");
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
					ctx.ui.notify(
						`Cannot save model class "${parsed.name}": ${e instanceof Error ? e.message : String(e)}`,
						"error",
					);
					return;
				}
				ctx.ui.notify(renderSaved(parsed.name, pair.model, pair.thinking), "info");
				return;
			}

			// switch — resolve and validate the whole target combination
			// BEFORE touching the session; any failure leaves it unchanged.
			let stored;
			try {
				stored = loadStored();
			} catch (e) {
				ctx.ui.notify(`Cannot switch: ${e instanceof Error ? e.message : String(e)}`, "error");
				return;
			}
			const resolved = resolveModelClass(parsed.name, stored, envFor(ctx));
			if (!resolved.ok) {
				ctx.ui.notify(resolved.error, "error");
				return;
			}
			const target = resolved.pair;
			const previous = ctx.model
				? { pair: { model: canonicalModelId(ctx.model), thinking: pi.getThinkingLevel() }, model: ctx.model }
				: null;
			const model = envFor(ctx).findModel(target.model);
			if (!model) {
				// Raced with a registry change after resolution; fail closed.
				ctx.ui.notify(notConfiguredError(parsed.name), "error");
				return;
			}
			const outcome = await applyResolvedPair(applier, { pair: target, model }, previous);
			if (!outcome.ok) {
				ctx.ui.notify(outcome.error, "error");
				return;
			}
			ctx.ui.notify(renderSwitched(parsed.name, target.model, target.thinking), "info");
		},
	});
}
