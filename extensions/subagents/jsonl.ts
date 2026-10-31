/**
 * Strict JSONL line reader for the pi RPC protocol.
 *
 * RPC mode uses LF (`\n`) as the only record delimiter; a trailing `\r`
 * (CRLF input) is stripped. Generic line readers are not protocol-compliant
 * because they also split on U+2028/U+2029 which are valid inside JSON
 * strings. Operates on Buffers so multi-byte characters split across chunks
 * are handled correctly.
 */
export class JsonlReader {
	private buf = Buffer.alloc(0);
	private readonly onLine: (line: string) => void;

	constructor(onLine: (line: string) => void) {
		this.onLine = onLine;
	}

	push(chunk: Buffer | string): void {
		const next = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
		this.buf = this.buf.length === 0 ? next : Buffer.concat([this.buf, next]);
		let idx: number;
		while ((idx = this.buf.indexOf(0x0a)) !== -1) {
			const lineBuf = this.buf.subarray(0, idx);
			this.buf = this.buf.subarray(idx + 1);
			let line = lineBuf.toString("utf8");
			if (line.endsWith("\r")) line = line.slice(0, -1);
			this.onLine(line);
		}
	}

	/** Flush a trailing line without a final newline (end of stream). */
	end(): void {
		if (this.buf.length === 0) return;
		let line = this.buf.toString("utf8");
		this.buf = Buffer.alloc(0);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		this.onLine(line);
	}
}
