/**
 * Provider-extension resolution for child spawns — the parent-side decision
 * of which local extension entries a child needs so `--model provider/id`
 * resolves inside a `--no-extensions` child.
 *
 * Why: children run with `--no-extensions` (explicit `-e` paths only), so a
 * model whose provider is registered by an extension (e.g. a git-installed
 * provider package) dies before RPC with `Error: Model "..." not found`
 * unless the parent passes the provider's extension entries. The parent knows
 * whether the provider is extension-registered at all:
 * `ctx.modelRegistry.getRegisteredProviderIds()` lists exactly the providers
 * added by extensions (builtin providers never appear there).
 *
 * Resolution is READ-ONLY: configured packages are enumerated through pi's
 * public `DefaultPackageManager.listConfiguredPackages()` (path computation +
 * existsSync; no install, no update, no network) and only already-installed
 * packages contribute entries. `npm:`/`git:` sources or bare names must never
 * reach a child `-e` — pi auto-installs those from the child process.
 *
 * Passing ALL installed, existing package extension entries (the bounded,
 * user-opted `settings.json` set) when a provider extension is needed is
 * deliberate: provider → package cannot be mapped statically without
 * executing extension code, and the configured set is small and trusted.
 *
 * Pure module: no pi runtime imports (parent facts arrive as structural
 * parameters), so bun tests exercise it directly against tmp fixtures.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** A configured package as pi's `listConfiguredPackages()` reports it. */
export interface ConfiguredPackageRef {
	source: string;
	/** Undefined ⇒ not installed ⇒ skipped (never installed on demand). */
	installedPath?: string;
}

/** Parent runtime facts the resolution needs. */
export interface ProviderExtensionFacts {
	/** Providers registered by extensions in this process (`getRegisteredProviderIds()`). */
	registeredProviderIds: readonly string[];
	/** The parent's configured packages (user + project scopes; read-only). */
	listPackages: () => ConfiguredPackageRef[];
}

export type ProviderExtensionResolution =
	| { kind: "not-needed" }
	| { kind: "ok"; entries: string[] }
	| { kind: "missing"; provider: string; message: string };

/**
 * Fail-fast error for a needed-but-missing provider extension. Callers catch
 * this BEFORE process creation and surface the message to the model.
 */
export class ProviderExtensionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProviderExtensionError";
	}
}

/** The `provider` part of a `provider/id` model reference. */
export function modelProvider(model: string | undefined): string {
	if (!model) return "";
	const idx = model.indexOf("/");
	return idx === -1 ? model : model.slice(0, idx);
}

/**
 * Extension entry paths contributed by one installed package, mirroring pi's
 * package resource resolution: `package.json` → `pi.extensions: string[]`
 * (paths resolved against the installed package root, existing files only);
 * fallback for manifest-less packages: the `extensions/` directory if it
 * exists, else the package directory itself.
 */
export function packageExtensionEntries(installedPath: string): string[] {
	let entries: unknown;
	try {
		const manifest = JSON.parse(fs.readFileSync(path.join(installedPath, "package.json"), "utf8")) as {
			pi?: { extensions?: unknown };
		};
		entries = manifest?.pi?.extensions;
	} catch {
		entries = undefined;
	}
	if (Array.isArray(entries)) {
		const resolved = entries
			.filter((e): e is string => typeof e === "string" && e.trim().length > 0)
			.map((rel) => path.resolve(installedPath, rel))
			.filter((p) => {
				try {
					return fs.existsSync(p);
				} catch {
					return false;
				}
			});
		if (resolved.length > 0) return resolved;
		// Declared but nothing exists on disk: treat like a broken manifest and
		// fall through to the directory fallbacks (mirrors pi's tolerance).
	}
	const extensionsDir = path.join(installedPath, "extensions");
	if (fs.existsSync(extensionsDir)) return [extensionsDir];
	return fs.existsSync(installedPath) ? [installedPath] : [];
}

/**
 * Actionable failure message: the model needs a provider this session itself
 * registered through an extension, but no installed package provides entries.
 */
export function missingProviderMessage(model: string, provider: string): string {
	return (
		`cannot spawn child for model "${model}": provider "${provider}" is registered by an extension in this ` +
		`session, but no configured, installed package provides its extension entries. Install the provider ` +
		`package (pi install <package-source>) or pick a model from a builtin provider.`
	);
}

/**
 * Resolve the extra `-e` entries a child needs for `model` ("provider/id").
 * - provider not extension-registered → not-needed (builtin or unknown: pi's
 *   builtin catalog must handle it — never add entries speculatively);
 * - needed and installed candidates exist → ok with all existing entries;
 * - needed but nothing resolves → missing with an actionable message.
 */
export function resolveProviderExtensions(model: string | undefined, facts: ProviderExtensionFacts): ProviderExtensionResolution {
	const provider = modelProvider(model);
	if (!provider || !facts.registeredProviderIds.includes(provider)) {
		return { kind: "not-needed" };
	}
	const entries = new Set<string>();
	for (const pkg of facts.listPackages()) {
		if (!pkg.installedPath) continue; // not installed ⇒ skip; no installs at spawn time
		for (const entry of packageExtensionEntries(pkg.installedPath)) entries.add(entry);
	}
	if (entries.size > 0) return { kind: "ok", entries: [...entries] };
	return { kind: "missing", provider, message: missingProviderMessage(model ?? "", provider) };
}

/**
 * Convenience wrapper for the spawn path: resolves and turns a `missing`
 * result into a thrown {@link ProviderExtensionError} so callers fail fast
 * before process creation.
 */
export function requireProviderExtensions(model: string | undefined, facts: ProviderExtensionFacts): string[] {
	const resolved = resolveProviderExtensions(model, facts);
	if (resolved.kind === "missing") throw new ProviderExtensionError(resolved.message);
	return resolved.kind === "ok" ? resolved.entries : [];
}
