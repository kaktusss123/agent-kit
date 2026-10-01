/**
 * Inherited, read-only machine inspection for a live agent-kit Pi process.
 *
 * This extension is deliberately inert unless both numeric descriptor
 * environment variables name already-open pipe descriptors. It creates no
 * transport and never registers a model or user-facing surface.
 */
import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Pi evaluates each extension entry through a fresh jiti instance with
// moduleCache: false, so module-level state forks per entry and per /reload
// while the streams created by a previous instance keep reading the
// inherited descriptors. The channel singleton, the session cwd, and the
// subagent source therefore live in one process-wide registry on globalThis
// (owned by the inspection seam): re-evaluated factories reuse the sole
// stream pair already attached to the process-owned transport.
import { inspectionRegistry as registry, inspectSubagents } from "../subagents/inspection-seam";
import {
  buildCurrentTaskProjection,
  matchActiveOwners,
  type CurrentTaskProjection,
  type OwnersFor,
  type SessionSelectionEntry,
} from "../task-workspace/current";
import { taskStatus } from "../task-workspace/flows";
import { resolveTaskRoot } from "../task-workspace/task-root";

export const REQUEST_FD_ENV = "AGENTKIT_INSPECT_REQUEST_FD";
export const RESPONSE_FD_ENV = "AGENTKIT_INSPECT_RESPONSE_FD";
const MAX_LINE_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const VERSION = 1;

type Area = "subagents" | "task" | "task_current" | "all";
type Request = { v: number; id: string; op: string; area: string };
export type InspectionDeps = {
  cwd: string;
  inspect?: () => Record<string, unknown>[];
  /** Current session branch entries (root → leaf) for the session-scoped
   *  current-task selection; defaults to the captured session manager. */
  branchEntries?: () => SessionSelectionEntry[];
  /** Active workspace RepoOwner matcher; defaults to matching this
   *  session's subagent runs against the exact repository workspace. */
  owners?: OwnersFor;
};

// Identifies this channel graph: only the owning graph may clear the
// captured session reader on session_shutdown (mirrors the subagents seam).
const instanceToken: object = {};

function defaultOwners(): OwnersFor {
  return (repoPath) => matchActiveOwners(inspectSubagents(), repoPath);
}

function defaultBranchEntries(): SessionSelectionEntry[] {
  const session = registry.session;
  if (!session) return [];
  return (session.manager.getBranch() ?? []) as SessionSelectionEntry[];
}

/** Session-scoped current-task projection: selection (managed cwd, else the
 *  latest successful ensure on the current session branch) plus the selected
 *  workspace's repo facts. Never guesses from the global task catalog. */
async function currentTaskProjection(deps: InspectionDeps): Promise<CurrentTaskProjection> {
  // The process cwd survives shutdown, but it is no longer bound to a live
  // session; never present that cwd-derived task as current until rebind.
  if (!deps.branchEntries && !registry.session) return { state: "none", identity: null, workspace: null, source: null, repos: [] };
  return buildCurrentTaskProjection({
    cwd: deps.cwd,
    taskRoot: resolveTaskRoot(),
    branchEntries: deps.branchEntries ? deps.branchEntries() : defaultBranchEntries(),
    owners: deps.owners ?? defaultOwners(),
  });
}

/** Legacy global catalog facts plus the ADDITIVE session-scoped `current`
 *  projection; v1 consumers keep reading the legacy fields unchanged. */
async function taskSnapshot(deps: InspectionDeps) {
  const [legacy, current] = await Promise.all([
    taskStatus({}, deps.cwd, { taskRoot: resolveTaskRoot() }),
    currentTaskProjection(deps),
  ]);
  return { ...legacy, current };
}

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
			output.removeListener("close", onClose);
		};
		const onDrain = () => { cleanup(); resolve(); };
		const onError = (error: Error) => { cleanup(); reject(error); };
		const onClose = () => { cleanup(); reject(new Error("output closed before drain")); };
		output.once("drain", onDrain);
		output.once("error", onError);
		output.once("close", onClose);
	});
}

export function validateRequest(value: unknown): { request?: Request; error?: { code: string; message: string } } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return protocolError("malformed_request", "request must be a JSON object");
	const request = value as Partial<Request>;
	if (request.v !== VERSION) return protocolError("unknown_version", "unsupported protocol version");
	if (typeof request.id !== "string" || request.id.length === 0 || request.id.length > 256) return protocolError("malformed_request", "id must be a non-empty string of at most 256 characters");
	if (request.op !== "snapshot") return protocolError("unknown_op", "unsupported operation");
	if (request.area !== "subagents" && request.area !== "task" && request.area !== "task_current" && request.area !== "all") return protocolError("unknown_area", "unsupported snapshot area");
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
		if (request.area === "task" || request.area === "all") data.task = await taskSnapshot(deps);
		// Scoped read: selection + selected workspace repos only — no global
		// catalog scan — for frequent task refresh (legacy `task`/`all` areas
		// stay available for full diagnostics).
		if (request.area === "task_current") data.task = { current: await currentTaskProjection(deps) };
		return { v: VERSION, id: request.id, ok: true, result: { v: VERSION, area: request.area, data } };
	} catch {
		return { v: VERSION, id: request.id, ok: false, error: { code: "snapshot_failed", message: "snapshot could not be read" } };
	}
}

export function startInheritedChannel(requestFd: number, responseFd: number, getCwd: () => string): boolean {
	if (registry.channel) return true;
	if (requestFd === responseFd || validateInheritedFd(String(requestFd)) !== requestFd || validateInheritedFd(String(responseFd)) !== responseFd) return false;

	let input: fs.ReadStream;
	let output: fs.WriteStream;
	try {
		input = fs.createReadStream(null as unknown as string, { fd: requestFd, autoClose: false, highWaterMark: 16 * 1024 });
		output = fs.createWriteStream(null as unknown as string, { fd: responseFd, autoClose: false, highWaterMark: 16 * 1024 });
	} catch {
		return false;
	}
	registry.channel = { input, output };
	let buffer = Buffer.alloc(0);
	const lines: Buffer[] = [];
	let busy = false;
	let stopped = false;

	const stop = () => {
		if (stopped) return;
		stopped = true;
		if (registry.channel?.input === input) registry.channel = undefined;
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
		registry.cwd = ctx.cwd;
		// Capture the CURRENT session's branch reader for the session-scoped
		// current-task projection. session_start fires on new sessions, resumes
		// and forks, so session switching can never leak another session's
		// selection; session_shutdown clears it (owner-token guarded).
		const manager = (ctx as { sessionManager?: { getBranch?: () => unknown[] } }).sessionManager;
		registry.session =
			manager && typeof manager.getBranch === "function"
				? { owner: instanceToken, manager }
				: undefined;
	});
	pi.on("session_shutdown", () => {
		if (registry.session?.owner === instanceToken) registry.session = undefined;
	});
	if (!registry.channel) {
		const pair = validateInheritedFdPair(process.env[REQUEST_FD_ENV], process.env[RESPONSE_FD_ENV]);
		if (pair) startInheritedChannel(pair.requestFd, pair.responseFd, () => registry.cwd);
	}
}
