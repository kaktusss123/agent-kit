import { describe, expect, test } from "bun:test";
import { JsonlReader } from "./jsonl";

function collect(): { reader: JsonlReader; lines: string[] } {
	const lines: string[] = [];
	return { reader: new JsonlReader((l) => lines.push(l)), lines };
}

describe("JsonlReader", () => {
	test("splits on LF only", () => {
		const { reader, lines } = collect();
		reader.push('{"a":1}\n{"b":\u2028"weird"}\n');
		expect(lines).toEqual(['{"a":1}', '{"b":\u2028"weird"}']);
	});

	test("reassembles lines split across chunks", () => {
		const { reader, lines } = collect();
		const full = `{"text":"${"x".repeat(100)}"}\n`;
		const buf = Buffer.from(full, "utf8");
		reader.push(buf.subarray(0, 7));
		reader.push(buf.subarray(7, 40));
		reader.push(buf.subarray(40));
		expect(lines).toEqual([full.trim()]);
	});

	test("handles multi-byte characters split across chunks", () => {
		const { reader, lines } = collect();
		const buf = Buffer.from('{"emoji":"👍👍"}\n', "utf8");
		// cut in the middle of the first emoji
		reader.push(buf.subarray(0, 11));
		reader.push(buf.subarray(11));
		expect(lines).toEqual(['{"emoji":"👍👍"}']);
		expect(JSON.parse(lines[0]).emoji).toBe("👍👍");
	});

	test("strips trailing CR from CRLF input", () => {
		const { reader, lines } = collect();
		reader.push('{"a":1}\r\n{"b":2}\r\n');
		expect(lines).toEqual(['{"a":1}', '{"b":2}']);
	});

	test("flushes trailing line without newline on end()", () => {
		const { reader, lines } = collect();
		reader.push('{"a":1}\n{"tail":');
		expect(lines).toEqual(['{"a":1}']);
		reader.end();
		expect(lines).toEqual(['{"a":1}', '{"tail":']);
	});
});
