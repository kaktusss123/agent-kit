---
name: omp-extension-verify
description: "Three-layer verification for an omp extension: bundle, loader-probe, provider-probe. Use before claiming an extension change works."
---

# Verifying an omp extension change works

## When to use
You have edited or written a `*.ts` (or `*.js`) file under `~/.omp/agent/extensions/`, an extension package's `extensions/` directory, or a `package.json`-manifested omp extension, and you need to confirm the change actually works at runtime — not just compiles.

A successful `bun build` is necessary but **not** sufficient. Three independent checks must pass:

1. **Bundle clean** — the file parses and TypeScript is happy.
2. **Loader clean** — the extension is discovered and its factory runs without error, with the expected commands/tools/handlers actually registered.
3. **Provider clean** — autocomplete / slash-command behaviour is exercised through the real runtime provider, not by calling callbacks directly.

Skipping layer 2 or 3 silently lets broken code ship. In this repo's history, a `pi.setLabel(...)` call at the top of a factory function threw during loading (`Extension runtime not initialized. Action methods cannot be called during extension loading.`), the entire extension failed to load, and **no commands were registered at all** — yet `bun build` reported success and the user saw "no autocomplete" with no error surfaced.

## Recipe

### Layer 1 — Bundle
```bash
bun build <path-to-extension>.ts --target=bun --outfile=/tmp/<name>.js
```
Expect: exits 0, no TS errors.

### Layer 2 — Loader probe
```ts
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

const result = await discoverAndLoadExtensions([], process.cwd(), "<agentDir>", null);
console.log("errors:", result.errors);          // MUST be empty
console.log("extensions:", result.extensions.length);
for (const ext of result.extensions) {
  for (const cmd of ext.commands?.values?.() ?? []) {
    console.log(cmd.name, "hasCompletion:", typeof cmd.getArgumentCompletions === "function");
  }
}
```
`<agentDir>` is typically `~/.omp/agent` or `~/.pi/agent` (check the installed package's `piConfig.configDir`). Confirm: `errors.length === 0`, every command the extension should register is present, and `getArgumentCompletions` is truthy exactly where it was set.

### Layer 3 — Provider probe (autocomplete)
```ts
import { CombinedAutocompleteProvider } from "@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js";

const cmds = [];
for (const ext of result.extensions) for (const c of ext.commands?.values?.() ?? []) {
  cmds.push({ name: c.name, description: c.description ?? "", getArgumentCompletions: c.getArgumentCompletions });
}
const provider = new CombinedAutocompleteProvider(cmds, process.cwd(), null);
const r = await provider.getSuggestions([slashLine], 0, slashLine.length, {});
// r is null (no suggestions) or { items: AutocompleteItem[], prefix: string }
```
Walk every input position you documented in the spec — empty, mid-token, trailing space, past-enum, non-matching prefix — and confirm each returns the expected `items` array or `null`. Calling `cmd.getArgumentCompletions(arg)` directly skips layer 3 and misses shape mismatches between your callback's return and what the provider/UI actually consume.

### Layer 4 — User-driven TUI check
You cannot launch an omp TUI session from a non-interactive shell. After layers 1–3 pass, hand off to the user and ask them to restart omp and visually confirm. Do **not** claim the change works end-to-end on the user's behalf.

## Common failure modes

- **`pi.setLabel(...)` at top of factory body** → throws during load, no commands registered. The `setLabel`/`sendUserMessage`/`appendEntry`/`setSessionName`/`setActiveTools`/etc. stubs are `notInitialized` until `bindCore()` runs (see `loader.js:133-154`). Move these calls into event handlers or deferred hooks (`on("session_start", ...)`, etc.).
- **Wrong import path** (`@oh-my-pi/pi-coding-agent` does not resolve outside the omp runtime) → jiti cannot load the file. Verify the import path matches what other extensions in the same directory use.
- **Autocomplete items in wrong shape** → if your callback returns raw strings, the provider forwards them but the UI may render them differently than `{ value, label }` items. Stick to `{ value, label }` for parity with built-in completions (which use `createFuzzyAutocompleteItems`).
- **Predicate fires past the enum position** → `(count === N && trailing) || count === N+1` re-shows the dropdown for a nonexistent next argument. Correct form: `(count === N && trailing) || (count === N+1 && !trailing)`.

## Scope guard
- `discoverAndLoadExtensions` requires a real `agentDir` — passing a non-existent path returns empty results, not an error, which can mask bugs. Always pass the user's actual agent dir.
- The provider probe runs in a Bun process, not in the omp TUI; layer 4 (visual confirmation) is the user's responsibility and must not be claimed.
