import { describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import { runWebSearch, WebSearchError, type RunWebSearchOptions } from "./codex.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function sseResponse(frames: string[], init?: ResponseInit): Response {
	return new Response(frames.join(""), {
		headers: { "content-type": "text/event-stream" },
		...init,
	});
}

function frame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function baseOptions(overrides: Partial<RunWebSearchOptions> = {}): RunWebSearchOptions {
	return {
		query: "latest stable Rust release",
		model: "gpt-test",
		token: "token",
		account: "acct_123",
		fetchImpl: async () => {
			throw new Error("no fetch configured");
		},
		...overrides,
	};
}

/** Access token JWT carrying the ChatGPT account claim (account id only). */
function tokenWithClaims(claims: Record<string, unknown>): string {
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": claims })).toString("base64url");
	return `header.${payload}.signature`;
}

const SUCCESS_SSE = [
	frame("response.created", { response: { id: "resp_1", model: "gpt-test-real" } }),
	frame("response.output_item.added", {
		item: { id: "ws_0", type: "web_search_call", status: "in_progress", action: { type: "search", query: "rust latest version" } },
	}),
	frame("response.output_item.done", {
		item: {
			id: "ws_0",
			type: "web_search_call",
			status: "completed",
			action: {
				type: "search",
				query: "rust latest version",
				sources: [{ url: "https://blog.rust-lang.org/2026/05/15/Rust-1.90.0/", title: "Announcing Rust 1.90.0" }],
			},
		},
	}),
	frame("response.output_item.done", {
		item: {
			type: "message",
			role: "assistant",
			content: [
				{
					type: "output_text",
					text: "The latest stable Rust release is Rust 1.90.0, published May 15, 2026 [1].",
					annotations: [
						{
							type: "url_citation",
							url: "https://blog.rust-lang.org/2026/05/15/Rust-1.90.0",
							title: "Announcing Rust 1.90.0",
							start_index: 52,
							end_index: 55,
						},
					],
				},
			],
		},
	}),
	frame("response.completed", {
		response: {
			id: "resp_1",
			model: "gpt-test-real",
			usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, input_tokens_details: { cached_tokens: 20 } },
		},
	}),
];

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("runWebSearch — successful search", () => {
	test("parses answer, citations, web_search_call sources and usage", async () => {
		const result = await runWebSearch(
			baseOptions({ fetchImpl: async () => sseResponse(SUCCESS_SSE) }),
		);
		expect(result.answer).toContain("Rust 1.90.0");
		expect(result.sources).toHaveLength(1);
		expect(result.sources[0]?.title).toBe("Announcing Rust 1.90.0");
		expect(result.sources[0]?.url).toBe("https://blog.rust-lang.org/2026/05/15/Rust-1.90.0");
		expect(result.searchQueries).toEqual(["rust latest version"]);
		expect(result.model).toBe("gpt-test-real");
		expect(result.requestId).toBe("resp_1");
		expect(result.usage).toEqual({ inputTokens: 80, outputTokens: 50, totalTokens: 150 });
	});

	test("sends the forced hosted web_search contract", async () => {
		let capturedUrl = "";
		let capturedHeaders = new Headers();
		let capturedBody: Record<string, unknown> = {};
		await runWebSearch(
			baseOptions({
				token: tokenWithClaims({ chatgpt_account_id: "acct_123" }),
				searchContextSize: "medium",
				fetchImpl: async (input, init) => {
					capturedUrl = String(input);
					capturedHeaders = new Headers(init?.headers);
					capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
					return sseResponse(SUCCESS_SSE);
				},
			}),
		);
		expect(capturedUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(capturedHeaders.get("authorization")).toBe("Bearer " + tokenWithClaims({ chatgpt_account_id: "acct_123" }));
		expect(capturedHeaders.get("chatgpt-account-id")).toBe("acct_123");
		expect(capturedHeaders.get("accept")).toBe("text/event-stream");
		expect(capturedBody.model).toBe("gpt-test");
		expect(capturedBody.store).toBe(false);
		expect(capturedBody.stream).toBe(true);
		expect(capturedBody.include).toEqual(["web_search_call.action.sources"]);
		expect(capturedBody.tool_choice).toEqual({ type: "web_search" });
		expect((capturedBody.tools as Array<Record<string, unknown>>)[0]?.type).toBe("web_search");
		expect((capturedBody.tools as Array<Record<string, unknown>>)[0]?.search_context_size).toBe("medium");
	});
});

// ---------------------------------------------------------------------------
// No web search ran
// ---------------------------------------------------------------------------

describe("runWebSearch — search not executed", () => {
	test("rejects a completion without web_search_call", async () => {
		const plainCompletion = [
			frame("response.created", { response: { id: "resp_2" } }),
			frame("response.output_item.done", {
				item: {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "I believe the latest Rust is 1.90.0 (from memory)." }],
				},
			}),
			frame("response.completed", { response: { id: "resp_2" } }),
		];
		let advanced = false;
		const error = await runWebSearch(
			baseOptions({
				fetchImpl: async () => {
					advanced = true;
					return sseResponse(plainCompletion);
				},
			}),
		).catch((e: unknown) => e);
		expect(advanced).toBe(true);
		expect(error).toBeInstanceOf(WebSearchError);
		expect((error as WebSearchError).kind).toBe("no_web_search");
		expect((error as WebSearchError).message).toMatch(/without running web search/);
	});
});

// ---------------------------------------------------------------------------
// HTTP-level failures
// ---------------------------------------------------------------------------

describe("runWebSearch — HTTP failures", () => {
	for (const status of [401, 403]) {
		test(`HTTP ${status} is classified as auth`, async () => {
			const error = await runWebSearch(
				baseOptions({ fetchImpl: async () => new Response("denied", { status }) }),
			).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(WebSearchError);
			expect((error as WebSearchError).kind).toBe("auth");
			expect((error as WebSearchError).status).toBe(status);
		});
	}

	test("HTTP 429 is classified as rate_limit", async () => {
		const error = await runWebSearch(
			baseOptions({ fetchImpl: async () => new Response("too many requests", { status: 429 }) }),
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(WebSearchError);
		expect((error as WebSearchError).kind).toBe("rate_limit");
	});

	test("HTTP 400 model-not-supported body is classified as unsupported_model", async () => {
		const error = await runWebSearch(
			baseOptions({
				fetchImpl: async () =>
					new Response(
						'{"error":{"message":"The requested model is not supported when using Codex with a ChatGPT account."}}',
						{ status: 400 },
					),
			}),
		).catch((e: unknown) => e);
		expect((error as WebSearchError).kind).toBe("unsupported_model");
	});
});

// ---------------------------------------------------------------------------
// Stream-level failures
// ---------------------------------------------------------------------------

describe("runWebSearch — stream errors", () => {
	test("response.failed with rate-limit message is classified as rate_limit", async () => {
		const error = await runWebSearch(
			baseOptions({
				fetchImpl: async () =>
					sseResponse([frame("response.failed", { error: { code: "rate_limit_exceeded", message: "Rate limit exceeded" } })]),
			}),
		).catch((e: unknown) => e);
		expect((error as WebSearchError).kind).toBe("rate_limit");
	});

	test("error event with unsupported-model message is classified as unsupported_model", async () => {
		const error = await runWebSearch(
			baseOptions({
				fetchImpl: async () =>
					sseResponse([frame("error", { code: "model_not_supported", message: "gpt-test is not supported when using Codex with a ChatGPT account" })]),
			}),
		).catch((e: unknown) => e);
		expect((error as WebSearchError).kind).toBe("unsupported_model");
	});
});

// ---------------------------------------------------------------------------
// Cancellation + timeout
// ---------------------------------------------------------------------------

describe("runWebSearch — cancellation and timeout", () => {
	test("surfaces external cancellation", async () => {
		const controller = new AbortController();
		const pending = runWebSearch(
			baseOptions({
				signal: controller.signal,
				// Fetch that only rejects when the signal fires, like a hung socket.
				fetchImpl: (_input, init) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
					}),
			}),
		);
		controller.abort(new DOMException("user hit esc", "AbortError"));
		const error = await pending.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(WebSearchError);
		expect((error as WebSearchError).kind).toBe("network");
		expect((error as WebSearchError).message).toContain("cancelled");
	});

	test("bounded timeout fires as timeout", async () => {
		const error = await runWebSearch(
			baseOptions({
				timeoutMs: 30,
				fetchImpl: (_input, init) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
					}),
			}),
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(WebSearchError);
		expect((error as WebSearchError).kind).toBe("timeout");
		expect((error as WebSearchError).message).toMatch(/timed out/);
	});
});

// ---------------------------------------------------------------------------
// Source deduplication
// ---------------------------------------------------------------------------

describe("runWebSearch — source deduplication", () => {
	test("collapses one URL arriving via web_search_call, citations and text", async () => {
		const sse = [
			frame("response.output_item.done", {
				item: {
					type: "web_search_call",
					status: "completed",
					action: {
						type: "search",
						sources: [
							{ url: "https://example.com/docs/guide?utm_source=openai", title: "https://example.com/docs/guide?utm_source=openai" },
						],
					},
				},
			}),
			frame("response.output_item.done", {
				item: {
					type: "message",
					role: "assistant",
					content: [
						{
							type: "output_text",
							text: "Read the guide [1](https://Example.com/docs/guide/) for details.",
							annotations: [
								{ type: "url_citation", url: "https://example.com/docs/guide", title: "The Guide", start_index: 0, end_index: 4 },
							],
						},
					],
				},
			}),
			frame("response.completed", { response: { id: "resp_3" } }),
		];
		const result = await runWebSearch(baseOptions({ fetchImpl: async () => sseResponse(sse) }));
		expect(result.sources).toHaveLength(1);
		expect(result.sources[0]?.url).toBe("https://example.com/docs/guide");
		// Title upgraded from the url-titled search-call source to the citation title.
		expect(result.sources[0]?.title).toBe("The Guide");
	});
});

// ---------------------------------------------------------------------------
// Empty / degenerate responses
// ---------------------------------------------------------------------------

describe("runWebSearch — degenerate responses", () => {
	test("answer with neither text nor sources is a backend error", async () => {
		const error = await runWebSearch(
			baseOptions({
				fetchImpl: async () =>
					sseResponse([
						frame("response.output_item.done", { item: { type: "web_search_call", status: "completed", action: {} } }),
						frame("response.completed", { response: { id: "resp_4" } }),
					]),
			}),
		).catch((e: unknown) => e);
		expect((error as WebSearchError).kind).toBe("backend");
		expect((error as WebSearchError).message).toMatch(/no answer and no sources/);
	});

	test("falls back to answer text URLs when annotations and include-sources are absent", async () => {
		const result = await runWebSearch(
			baseOptions({
				fetchImpl: async () =>
					sseResponse([
						frame("response.output_item.done", { item: { type: "web_search_call", status: "completed", action: {} } }),
						frame("response.output_item.done", {
							item: {
								type: "message",
								role: "assistant",
								content: [
									{ type: "output_text", text: "See [Rust blog](https://blog.rust-lang.org/2026/05/15/Rust-1.90.0/) and https://releases.rs." },
								],
							},
						}),
						frame("response.completed", { response: { id: "resp_5" } }),
					]),
			}),
		);
		expect(result.answer).toContain("Rust blog");
		expect(result.sources.map(s => s.url)).toEqual([
			"https://blog.rust-lang.org/2026/05/15/Rust-1.90.0",
			"https://releases.rs/",
		]);
	});
});
