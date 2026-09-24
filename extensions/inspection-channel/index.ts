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

type Area = "subagents" | "task" | "all";
type Request = { v: number; id: string; op: string; area: string };
export type InspectionDeps = { cwd: string; inspect?: () => Record<string, unknown>[] };

export function validateInheritedFd(value: string | undefined): number | undefined {
	if (!value || !/^(?:0|[1-9][0-9]*)$/.test(value)) return undefined;
	const fd = Number(value);
	if (!Number.isSafeInteger(fd) || fd < 0) return undefined;
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFIFO() && !stat.isSocket()) return undefined;
		return fd;
	} catch {
		return undefined;
	}
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

function startInheritedChannel(getCwd: () => string): void {
	const requestFd = validateInheritedFd(process.env[REQUEST_FD_ENV]);
	const responseFd = validateInheritedFd(process.env[RESPONSE_FD_ENV]);
	if (requestFd === undefined || responseFd === undefined) return;

	let input: fs.ReadStream;
	let output: fs.WriteStream;
	try {
		input = fs.createReadStream(null as unknown as string, { fd: requestFd, autoClose: false, highWaterMark: 16 * 1024 });
		output = fs.createWriteStream(null as unknown as string, { fd: responseFd, autoClose: false, highWaterMark: 16 * 1024 });
	} catch {
		return;
	}
	let buffer = "";
	let busy = false;
	let stopped = false;

	const stop = () => {
		if (stopped) return;
		stopped = true;
		input.destroy();
		output.destroy();
	};
	const writeResponse = async (response: Record<string, unknown>) => {
		const line = JSON.stringify(response) + "\n";
		if (Buffer.byteLength(line) > MAX_RESPONSE_BYTES) throw new Error("response exceeds protocol bound");
		if (!output.write(line)) await new Promise<void>((resolve, reject) => {
			output.once("drain", resolve);
			output.once("error", reject);
		});
	};
	const consume = async () => {
		if (busy || stopped) return;
		const newline = buffer.indexOf("\n");
		if (newline < 0) {
			if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) stop();
			return;
		}
		const line = buffer.slice(0, newline).replace(/\r$/, "");
		buffer = buffer.slice(newline + 1);
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
		buffer += chunk.toString();
		void consume();
	});
	input.on("end", stop);
	input.on("error", stop);
	output.on("error", stop);
}

export default function registerInspectionChannel(pi: ExtensionAPI): void {
	let cwd = process.cwd();
	pi.on("session_start", (_event, ctx) => {
		cwd = ctx.cwd;
	});
	// Descriptor validation is intentionally repeated at registration time: an
	// invalid inherited value must be inert, never an extension-startup failure.
	startInheritedChannel(() => cwd);
}
