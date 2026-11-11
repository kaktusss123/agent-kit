/** Run manually with existing Pi OAuth; never prints or copies credentials. */
import assert from "node:assert/strict";
import { ModelRegistry, ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { resolveCodexCredential } from "../auth.ts";
import { runWebSearch } from "../codex.ts";

const signal = AbortSignal.timeout(90_000);
// No catalog network requests, persisted model cache, or config writes.
// OAuth resolution/refresh remains entirely inside Pi's public runtime.
const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, signal });
const credential = await resolveCodexCredential(new ModelRegistry(runtime), readStoredCredential);
let evidence: Promise<string> | undefined;
let endpoint = "";
const result = await runWebSearch({
	query: "site:nodejs.org latest Node.js LTS release official announcement",
	model: process.argv[2] ?? "gpt-6.1-terra",
	credential,
	signal,
	timeoutMs: 80_000,
	fetchImpl: async (url, init) => {
		endpoint = String(url);
		const response = await fetch(url, init);
		evidence = response.clone().text();
		return response;
	},
});
const stream = await evidence;
assert.ok(stream && /"type"\s*:\s*"web_search_call"/.test(stream), "No hosted web_search_call event");
assert.match(stream, /response\.completed|response\.done/, "No completion event");
assert.ok(result.answer.trim(), "No usable answer");
assert.ok(result.sources.some(source => /^https?:\/\//.test(source.url)), "No usable source URLs");
console.log(JSON.stringify({
	provider: credential.provider,
	endpoint,
	model: result.model,
	hostedSearchObserved: true,
	completed: true,
	answerCharacters: result.answer.length,
	sourceCount: result.sources.length,
	sources: result.sources.slice(0, 5).map(({ title, url }) => ({ title, url })),
}, null, 2));
