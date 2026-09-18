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

/**
 * Live parent facts captured from the extension ctx beside the model
 * registry. They bound the PROJECT scope of package enumeration.
 */
export interface ParentRuntimeFacts {
	/** The parent's cwd at refresh time (project scope for settings/packages). */
	cwd: string;
	/**
	 * `ctx.isProjectTrusted()`. False ⇒ pi must not read the project's
	 * settings at all, so its `packages` never reach a child `-e` (untrusted
	 * content must not become local code execution). User-scope packages are
	 * unaffected.
	 */
	projectTrusted: boolean;
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
 * Extension entries a child `-e` can load from one installed package,
 * mirroring pi's package resource resolution: `package.json` →
 * `pi.extensions: string[]` (paths resolved against the installed package
 * root, existing files only). Every other shape — manifest missing or
 * unreadable, declared entries that do not exist, manifest-less packages —
 * falls back to the package directory itself.
 *
 * Live-verified nuance (acceptance smoke): pi loads a `-e` DIRECTORY as an
 * extension in its own right (entry-file lookup inside it), so a directory
 * must NEVER be the entry — neither a manifest entry that resolves to a
 * directory (the common `"./extensions"` shape) nor the package's own
 * `extensions/` directory. The package ROOT is passed instead, and pi
 * resolves its own manifest/discovery exactly like it does for discovery.
 * File entries are passed as-is.
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
		const declared = entries
			.filter((e): e is string => typeof e === "string" && e.trim().length > 0)
			.map((rel) => path.resolve(installedPath, rel))
			.filter((p) => {
				try {
					return fs.existsSync(p);
				} catch {
					return false;
				}
			});
		if (declared.length > 0) {
			// Any directory entry (the common `"./extensions"` shape): the package
			// root is the only reliable -e — pi applies its own package loader.
			const hasDir = declared.some((p) => {
				try {
					return fs.statSync(p).isDirectory();
				} catch {
					return false;
				}
			});
			if (hasDir) return [installedPath];
			return declared;
		}
		// Declared but nothing exists on disk: treat like a broken manifest and
		// fall through to the package-root fallback (mirrors pi's tolerance).
	}
	// No usable manifest-declared entries (missing/unreadable manifest, or it
	// declares nothing that exists): the package ROOT is the entry. A `-e`
	// directory is loaded as a single extension file — passing the package's
	// own `extensions/` directory here would kill the child with
	// "module not found"; the root lets pi resolve its own discovery.
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
