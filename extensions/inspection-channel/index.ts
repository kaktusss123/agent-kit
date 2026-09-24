/**
 * Inherited, read-only machine inspection for a live agent-kit Pi process.
 *
 * This extension is deliberately inert unless both numeric descriptor
 * environment variables name already-open pipe descriptors. It creates no
 * transport and never registers a model or user-facing surface.
 */
import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inspectSubagents } from "../subagents/inspection-seam";
import { taskStatus } from "../task-workspace/flows";
import { resolveTaskRoot } from "../task-workspace/task-root";

export const REQUEST_FD_ENV = "AGENTKIT_INSPECT_REQUEST_FD";
export const RESPONSE_FD_ENV = "AGENTKIT_INSPECT_RESPONSE_FD";
const MAX_LINE_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const VERSION = 1;
let activeChannel: { input: fs.ReadStream; output: fs.WriteStream } | undefined;
let currentCwd = process.cwd();

type Area = "subagents" | "task" | "all";
type Request = { v: number; id: string; op: string; area: string };
export type InspectionDeps = { cwd: string; inspect?: () => Record<string, unknown>[] };

export function validateInheritedFd(value: string | undefined): number | undefined {
	if (!value || !/^(?:0|[1-9][0-9]*)$/.test(value)) return undefined;
	const fd = Number(value);
	if (!Number.isSafeInteger(fd) || fd <= 2) return undefined;
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFIFO() && !stat.isSocket()) return undefined;
		return fd;
	} catch {
		return undefined;
	}
}

export function validateInheritedFdPair(requestValue: string | undefined, responseValue: string | undefined): { requestFd: number; responseFd: number } | undefined {
	if (requestValue === undefined || responseValue === undefined || requestValue === responseValue) return undefined;
	const requestFd = validateInheritedFd(requestValue);
	const responseFd = validateInheritedFd(responseValue);
	return requestFd === undefined || responseFd === undefined ? undefined : { requestFd, responseFd };
}

export function frameJsonLines(buffer: Buffer, chunk: Buffer): { lines: Buffer[]; remainder: Buffer; oversized: boolean } {
	const data = Buffer.concat([buffer, chunk]);
	const lines: Buffer[] = [];
	let offset = 0;
	for (;;) {
		const newline = data.indexOf(0x0a, offset);
		if (newline < 0) break;
		const frameLength = newline + 1 - offset;
		if (frameLength > MAX_LINE_BYTES) return { lines, remainder: Buffer.alloc(0), oversized: true };
		lines.push(data.subarray(offset, newline));
		offset = newline + 1;
	}
	const remainder = data.subarray(offset);
	return { lines, remainder, oversized: remainder.length > MAX_LINE_BYTES };
}

export function waitForDrain(output: NodeJS.WritableStream): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			output.removeListener("drain", onDrain);
			output.removeListener("error", onError);
		};
		const onDrain = () => { cleanup(); resolve(); };
		const onError = (error: Error) => { cleanup(); reject(error); };
		output.once("drain", onDrain);
		output.once("error", onError);
	});
}

export function validateRequest(value: unknown): { request?: Request; error?: { code: string; message: string } } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return protocolError("malformed_request", "request must be a JSON object");
	const request = value as Partial<Request>;
	if (request.v !== VERSION) return protocolError("unknown_version", "unsupported protocol version");
	if (typeof request.id !== "string" || request.id.length === 0 || request.id.length > 256) return protocolError("malformed_request", "id must be a non-empty string of at most 256 characters");
	if (request.op !== "snapshot") return protocolError("unknown_op", "unsupported operation");
	if (request.area !== "subagents" && request.area !== "task" && request.area !== "all") return protocolError("unknown_area", "unsupported snapshot area");
	return { request: request as Request };
}

function protocolError(code: string, message: string) {
	return { error: { code, message } };
}

export async function handleInspectionRequest(raw: string, deps: InspectionDeps): Promise<Record<string, unknown>> {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { v: VERSION, id: null, ok: false, error: { code: "malformed_json", message: "request is not valid JSON" } };
	}
	const checked = validateRequest(value);
	if (checked.error) {
		const id = value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" ? (value as { id: string }).id : null;
		return { v: VERSION, id, ok: false, error: checked.error };
	}
	const request = checked.request!;
	try {
		const data: Record<string, unknown> = {};
		if (request.area === "subagents" || request.area === "all") data.agents = (deps.inspect ?? inspectSubagents)();
		if (request.area === "task" || request.area === "all") data.task = await taskStatus({}, deps.cwd, { taskRoot: resolveTaskRoot() });
		return { v: VERSION, id: request.id, ok: true, result: { v: VERSION, area: request.area, data } };
	} catch {
		return { v: VERSION, id: request.id, ok: false, error: { code: "snapshot_failed", message: "snapshot could not be read" } };
	}
}

export function startInheritedChannel(requestFd: number, responseFd: number, getCwd: () => string): boolean {
	if (activeChannel) return true;
	if (requestFd === responseFd || validateInheritedFd(String(requestFd)) !== requestFd || validateInheritedFd(String(responseFd)) !== responseFd) return false;

	let input: fs.ReadStream;
	let output: fs.WriteStream;
	try {
		input = fs.createReadStream(null as unknown as string, { fd: requestFd, autoClose: false, highWaterMark: 16 * 1024 });
		output = fs.createWriteStream(null as unknown as string, { fd: responseFd, autoClose: false, highWaterMark: 16 * 1024 });
	} catch {
		return false;
	}
	activeChannel = { input, output };
	let buffer = Buffer.alloc(0);
	const lines: Buffer[] = [];
	let busy = false;
	let stopped = false;

	const stop = () => {
		if (stopped) return;
		stopped = true;
		if (activeChannel?.input === input) activeChannel = undefined;
		input.destroy();
		output.destroy();
	};
	const writeResponse = async (response: Record<string, unknown>) => {
		const line = JSON.stringify(response) + "\n";
		if (Buffer.byteLength(line) > MAX_RESPONSE_BYTES) throw new Error("response exceeds protocol bound");
		if (!output.write(line)) await waitForDrain(output);
	};
	const consume = async () => {
		if (busy || stopped) return;
		const frame = lines.shift();
		if (!frame) return;
		const line = frame.toString("utf8").replace(/\r$/, "");
		busy = true;
		input.pause();
		try {
			await writeResponse(await handleInspectionRequest(line, { cwd: getCwd() }));
		} catch {
			stop();
			return;
		} finally {
			busy = false;
		}
		if (!stopped) {
			input.resume();
			void consume();
		}
	};
	input.on("data", (chunk: Buffer | string) => {
		const parsed = frameJsonLines(buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		if (parsed.oversized) { stop(); return; }
		buffer = parsed.remainder;
		lines.push(...parsed.lines);
		void consume();
	});
	input.on("end", stop);
	input.on("error", stop);
	output.on("error", stop);
	return true;
}

export default function registerInspectionChannel(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		currentCwd = ctx.cwd;
	});
	// Pi invokes extension factories again for session changes. The transport
	// is process-owned, not session-owned; reuse its sole stream pair and read
	// the latest cwd when each request arrives.
	if (!activeChannel) {
		const pair = validateInheritedFdPair(process.env[REQUEST_FD_ENV], process.env[RESPONSE_FD_ENV]);
		if (pair) startInheritedChannel(pair.requestFd, pair.responseFd, () => currentCwd);
	}
}
