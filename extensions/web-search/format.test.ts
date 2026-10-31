import { describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import type { WebSearchResult } from "./codex.ts";
import { formatForModel } from "./format.ts";

function result(overrides: Partial<WebSearchResult> = {}): WebSearchResult {
	return {
		answer: "Rust 1.90.0 is the latest stable release.",
		sources: [
			{ url: "https://blog.rust-lang.org/", title: "Rust Blog" },
			{ url: "https://releases.rs", title: "releases.rs" },
		],
		searchQueries: ["latest stable Rust release"],
		model: "gpt-5.6-luna",
		...overrides,
	};
}

describe("formatForModel — compact model-facing output", () => {
	test("answer plus numbered sources with titles and urls", () => {
		const text = formatForModel(result());
		expect(text).toContain("Rust 1.90.0 is the latest stable release.");
		expect(text).toContain("[1] Rust Blog\n    https://blog.rust-lang.org/");
		expect(text).toContain("[2] releases.rs\n    https://releases.rs");
	});

	test("never includes raw SSE markers or response envelopes", () => {
		const text = formatForModel(result());
		expect(text).not.toMatch(/event:|data:|\[DONE\]|response\.completed/);
		expect(text).not.toContain("searchQueries");
		expect(text).not.toContain("resp_1");
		expect(text).not.toContain('"model"');
	});

	test("caps the source list with an omission note", () => {
		const many = Array.from({ length: 35 }, (_, i) => ({ url: `https://example.com/${i}`, title: `S${i}` }));
		const text = formatForModel(result({ sources: many }));
		expect(text).toContain("[20] S19");
		expect(text).not.toContain("[21]");
		expect(text).toContain("(+15 more sources omitted)");
	});

	test("long titles are truncated", () => {
		const text = formatForModel(result({ sources: [{ url: "https://example.com", title: "x".repeat(300) }] }));
		expect(text.length).toBeLessThan(400);
		expect(text).toContain("…");
	});

	test("sources-only result states the absence of an answer", () => {
		const text = formatForModel(result({ answer: "" }));
		expect(text).toContain("sources without an answer");
		expect(text).toContain("[1] Rust Blog");
	});
});
