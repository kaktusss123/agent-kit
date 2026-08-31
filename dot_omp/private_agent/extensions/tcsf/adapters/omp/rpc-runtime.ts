import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentSessionHandle, AgentSessionRef, AgentSessionStatus, AgentTurnRef, AgentTurnResult } from "../../core/types.ts";
import type { AgentRuntime, AgentTurnInput, CreateAgentSessionInput } from "../../ports/agent-runtime.ts";
import { decodeRpcLine, type RpcFrame } from "./protocol.ts";

export interface OmpRpcRuntimeOptions { ompCommand?: string; defaultTimeoutMs?: number; turnTimeoutMs?: number; rpcSilenceTimeoutMs?: number; }
interface PendingTurn { ref: AgentTurnRef; result: Promise<AgentTurnResult>; resolve: (result: AgentTurnResult) => void; reject: (error: Error) => void; stopReason?: AgentTurnResult["stopReason"]; output: string[]; failureMessage?: string; timeoutMs: number; }
interface RpcProcess { pid: number; stdin: { write(data: string): number | Promise<number>; end(): void }; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(signal?: string): void; }
interface ProcessState { transportId: string; process: RpcProcess; ref: AgentSessionRef; pending: Map<string, PendingTurn>; responses: Map<string, { promise: Promise<RpcFrame>; resolve: (frame: RpcFrame) => void }>; ready: Promise<void>; readyResolve: () => void; lastStatus: AgentSessionStatus; eventLogPath?: string; stderrLogPath?: string; persistQueue: Promise<void>; lastFrameAt: number; nextSequence: number; uiResponses: Set<string>; }

export class OmpRpcAgentRuntime implements AgentRuntime {
  readonly kind = "omp-rpc";
  private readonly processes = new Map<string, ProcessState>();
  private readonly ompCommand: string;
  private readonly defaultTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly rpcSilenceTimeoutMs?: number;
  constructor(options: OmpRpcRuntimeOptions = {}) { this.ompCommand = options.ompCommand ?? "omp"; this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000; this.turnTimeoutMs = options.turnTimeoutMs ?? 120_000; this.rpcSilenceTimeoutMs = options.rpcSilenceTimeoutMs; }
  async createSession(input: CreateAgentSessionInput): Promise<AgentSessionRef> {
    const sessionDirectory = input.sessionDirectory ?? join(".", "tcsf-sessions"); await mkdir(sessionDirectory, { recursive: true });
    const policyPrompt = `${input.systemPrompt}\nWorkspace roots: ${input.workspaceRoots.join(", ") || "none"}. Read-only roots: ${input.readOnlyRoots.join(", ") || "none"}. Role: ${input.role}. Do not write outside workspace roots or modify read-only roots.`;
    const state = await this.spawn(input.cwd, sessionDirectory, policyPrompt, input.model, undefined, input.noTools === true, input.workspaceRoots);
    const response = await this.command(state, { type: "get_state" });
    if (response.type !== "response" || !response.success || !isSessionState(response.data)) { await this.close(stateHandle(state)); throw new Error("OMP RPC did not return a session state"); }
    const ref: AgentSessionRef = { kind: this.kind, sessionId: response.data.sessionId, metadata: { sessionFile: response.data.sessionFile, cwd: input.cwd, sessionDirectory, noTools: input.noTools === true, role: input.role, workspaceRoots: input.workspaceRoots, readOnlyRoots: input.readOnlyRoots, policyMode: "extensions-disabled-parent-integrity" } }; state.ref = ref; await this.close(stateHandle(state)); return ref;
  }
  async resumeSession(ref: AgentSessionRef): Promise<AgentSessionHandle> {
    const metadata = ref.metadata ?? {}; const cwd = typeof metadata.cwd === "string" ? metadata.cwd : "."; const sessionDirectory = typeof metadata.sessionDirectory === "string" ? metadata.sessionDirectory : undefined; const sessionFile = typeof metadata.sessionFile === "string" ? metadata.sessionFile : ref.sessionId; const noTools = metadata.noTools === true; const workspaceRoots = Array.isArray(metadata.workspaceRoots) ? metadata.workspaceRoots.filter((value): value is string => typeof value === "string") : [];
    const state = await this.spawn(cwd, sessionDirectory, undefined, undefined, sessionFile, noTools, workspaceRoots); state.ref = ref; state.nextSequence = typeof metadata.lastTurnSequence === "number" ? metadata.lastTurnSequence + 1 : 1; return stateHandle(state);
  }
  async sendTurn(handle: AgentSessionHandle, input: AgentTurnInput): Promise<AgentTurnRef> { const state = this.state(handle); const ref: AgentTurnRef = { turnId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`, sequenceNumber: state.nextSequence++ }; const metadata = state.ref.metadata ?? {}; metadata.lastTurnSequence = ref.sequenceNumber; if (!state.ref.metadata) state.ref = { ...state.ref, metadata }; const { promise, resolve, reject } = Promise.withResolvers<AgentTurnResult>(); state.pending.set(ref.turnId, { ref, result: promise, resolve, reject, output: [], timeoutMs: input.timeoutMs ?? this.turnTimeoutMs });
    const marker = input.logicalTurnId && input.contentHash ? `\n[TCSF logical-turn id=${input.logicalTurnId} content-hash=${input.contentHash}]\n` : ""; try { await state.process.stdin.write(`${JSON.stringify({ id: ref.turnId, type: "prompt", message: `${input.prompt}${marker}`, logicalTurnId: input.logicalTurnId, contentHash: input.contentHash })}\n`); } catch (error) { state.pending.delete(ref.turnId); reject(error instanceof Error ? error : new Error(String(error))); }
    return ref;
  }
  async waitForTurn(handle: AgentSessionHandle, turn: AgentTurnRef): Promise<AgentTurnResult> {
    const state = this.state(handle); const pending = state.pending.get(turn.turnId); if (!pending) throw new Error(`unknown turn ${turn.turnId}`);
    const timeoutPromise = timeout(pending.timeoutMs, `OMP RPC turn timed out after ${pending.timeoutMs}ms`);
    const inactivityPromise = this.rpcSilenceTimeoutMs ? this.silenceWatch(state, turn, this.rpcSilenceTimeoutMs) : undefined;
    try { const result = await Promise.race([pending.result, timeoutPromise, ...(inactivityPromise ? [inactivityPromise] : [])]); return result; }
    catch (error) { if (state.pending.has(turn.turnId)) { state.pending.delete(turn.turnId); pending.reject(error instanceof Error ? error : new Error(String(error))); state.process.kill("SIGTERM"); } throw error; }
  }
  async interruptTurn(handle: AgentSessionHandle, _turn: AgentTurnRef): Promise<void> { await this.state(handle).process.stdin.write(`${JSON.stringify({ id: `abort-${Date.now()}`, type: "abort" })}\n`); }
  async inspectSession(ref: AgentSessionRef): Promise<AgentSessionStatus> { const active = [...this.processes.values()].find(state => state.ref.sessionId === ref.sessionId); if (active) return active.lastStatus; const sessionFile = typeof ref.metadata?.sessionFile === "string" ? ref.metadata.sessionFile : undefined; return { state: sessionFile && existsSync(sessionFile) ? "idle" : "unknown", messageCount: 0 }; }
  async reconcileTurn(ref: AgentSessionRef, input: { logicalTurnId: string; prompt: string; contentHash: string }): Promise<"completed" | "not_accepted" | "unknown"> {
    const metadata = ref.metadata ?? {};
    const sessionFile = typeof metadata.sessionFile === "string" ? metadata.sessionFile : undefined;
    const sessionDirectory = typeof metadata.sessionDirectory === "string" ? metadata.sessionDirectory : undefined;
    const candidates = new Set<string>(sessionFile && existsSync(sessionFile) ? [sessionFile] : []);
    if (sessionDirectory && existsSync(sessionDirectory)) {
      for (const name of await readdir(sessionDirectory)) if (name.endsWith(".jsonl") && !name.endsWith(".protocol.jsonl")) candidates.add(join(sessionDirectory, name));
    }
    if (candidates.size === 0) return "unknown";
    let promptSeen = false;
    const markerPattern = /\[TCSF logical-turn id=([^\s\]]+) content-hash=([^\s\]]+)\]/u;
    for (const candidate of candidates) {
      const records = (await readFile(candidate, "utf8")).split("\n").filter(Boolean).map(line => { try { return JSON.parse(line) as Record<string, any>; } catch { return undefined; } }).filter((record): record is Record<string, any> => Boolean(record));
      for (let index = 0; index < records.length; index += 1) {
        const message = records[index]?.message;
        if (!message || message.role !== "user" || !Array.isArray(message.content)) continue;
        const text = message.content.filter((part: any) => part && part.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("");
        const marker = text.match(markerPattern);
        if (text !== input.prompt || !marker || marker[1] !== input.logicalTurnId || marker[2] !== input.contentHash) continue;
        promptSeen = true;
        for (const following of records.slice(index + 1)) {
          const assistant = following.message;
          if (assistant?.role === "user") break;
          if (!assistant || assistant.role !== "assistant" || !Array.isArray(assistant.content)) continue;
          for (const part of assistant.content) {
            if (part?.type !== "text" || typeof part.textSignature !== "string") continue;
            try { if (JSON.parse(part.textSignature).phase === "final_answer") return "completed"; } catch {}
          }
        }
      }
    }
    return promptSeen ? "unknown" : "not_accepted";
  }
  async close(handle: AgentSessionHandle): Promise<void> { const state = this.state(handle); for (const pending of state.pending.values()) pending.reject(new Error("OMP RPC transport closed")); state.pending.clear(); state.process.stdin.end(); state.process.kill("SIGTERM"); const exited = await Promise.race([state.process.exited.then(() => true), delay(2_000).then(() => false)]); if (!exited) { state.process.kill("SIGKILL"); await state.process.exited; } await state.persistQueue; this.processes.delete(handle.transportId); }
  private async spawn(cwd: string, sessionDirectory: string | undefined, systemPrompt: string | undefined, model: string | undefined, resume: string | undefined, noTools: boolean, workspaceRoots: readonly string[]): Promise<ProcessState> {
    const args = ["--mode", "rpc", "--no-title", "--no-extensions", "--no-skills", "--no-rules", "--cwd", cwd, "--auto-approve"]; for (const root of workspaceRoots) args.push("--add-dir", root); if (noTools) args.push("--no-tools"); if (sessionDirectory) args.push("--session-dir", sessionDirectory); if (systemPrompt) args.push("--system-prompt", systemPrompt); if (model) args.push("--model", model); if (resume) args.push("--resume", resume);
    const process = Bun.spawn([this.ompCommand, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" } as const) as RpcProcess; const { promise: ready, resolve: readyResolve } = Promise.withResolvers<void>(); const transportId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; const eventLogPath = sessionDirectory ? join(sessionDirectory, `${transportId}.protocol.jsonl`) : undefined; const state: ProcessState = { transportId, process, ref: { kind: this.kind, sessionId: "pending" }, pending: new Map(), responses: new Map(), ready, readyResolve, lastStatus: { state: "unknown", messageCount: 0 }, eventLogPath, persistQueue: Promise.resolve(), lastFrameAt: Date.now(), nextSequence: 1, uiResponses: new Set() }; this.processes.set(transportId, state); if (eventLogPath) void mkdir(dirname(eventLogPath), { recursive: true }); void this.readFrames(state);
    state.persistQueue = Promise.resolve(); void drainStderr(process.stderr, eventLogPath ? `${eventLogPath}.stderr` : undefined);
    return state;
  }
  private async readFrames(state: ProcessState): Promise<void> { const reader = state.process.stdout.getReader(); const decoder = new TextDecoder(); let buffer = ""; try { while (true) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; for (const line of lines) { const frame = decodeRpcLine(line); if (frame) { state.lastFrameAt = Date.now(); state.persistQueue = state.persistQueue.then(() => this.persistFrame(state, frame)); this.handleFrame(state, frame); } } } } catch (error) { const failure = error instanceof Error ? error : new Error(String(error)); for (const pending of state.pending.values()) pending.reject(failure); } for (const pending of state.pending.values()) pending.reject(new Error("OMP RPC process exited before terminal event")); }
  private async persistFrame(state: ProcessState, frame: RpcFrame): Promise<void> { if (state.eventLogPath) await appendFile(state.eventLogPath, `${JSON.stringify(frame)}\n`, "utf8"); }
  private handleFrame(state: ProcessState, frame: RpcFrame): void {
    if (frame.type === "ready") { state.readyResolve(); return; }
    if (frame.type === "response" && frame.id) { const waiter = state.responses.get(frame.id); if (waiter) { state.responses.delete(frame.id); waiter.resolve(frame); } return; }
    if (frame.type === "extension_ui_request") {
      if (state.uiResponses.has(frame.id)) return;
      state.uiResponses.add(frame.id);
      const response: Record<string, unknown> = { type: "extension_ui_response", id: frame.id, cancelled: true };
      state.persistQueue = state.persistQueue.then(() => this.persistFrame(state, response as RpcFrame)).catch(() => undefined);
      Promise.resolve(state.process.stdin.write(`${JSON.stringify(response)}\n`)).catch(() => undefined);
      if (["setWidget", "setStatus", "notify", "setTitle", "set_editor_text"].includes(frame.method)) return;
      const pending = [...state.pending.values()][0];
      if (pending) { pending.failureMessage = `unattended OMP UI request rejected: ${frame.method}`; pending.reject(new Error(pending.failureMessage)); state.pending.delete(pending.ref.turnId); }
      return;
    }
    const pending = [...state.pending.values()][0];
    if (frame.type === "message_end" && pending) { const text = textFromMessage(frame.message); if (text) pending.output.push(text); return; }
    if (frame.type === "agent_start") { state.lastStatus = { state: "running", messageCount: state.lastStatus.messageCount }; return; }
    if (frame.type === "turn_end" && pending && (frame.stopReason === "aborted" || frame.stopReason === "error" || frame.errorMessage)) { pending.stopReason = frame.stopReason === "aborted" ? "aborted" : "error"; pending.failureMessage = frame.errorMessage ?? `OMP turn ended with ${frame.stopReason ?? "error"}`; return; }
    if (frame.type === "agent_end" && frame.isTerminal !== false && pending) { const messageCount = Array.isArray(frame.messages) ? frame.messages.length : state.lastStatus.messageCount; state.lastStatus = { state: "idle", messageCount, lastTurnAt: new Date().toISOString() }; state.pending.delete(pending.ref.turnId); if (pending.output.length === 0 && Array.isArray(frame.messages)) pending.output.push(...frame.messages.map(textFromMessage).filter(Boolean)); pending.resolve({ terminal: true, success: !pending.failureMessage && pending.stopReason !== "aborted", stopReason: pending.stopReason ?? "completed", errorMessage: pending.failureMessage, messageCount, outputText: pending.output.join("\n") }); }
  }
  private async command(state: ProcessState, command: Record<string, unknown>): Promise<RpcFrame> { const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; const { promise, resolve } = Promise.withResolvers<RpcFrame>(); state.responses.set(id, { promise, resolve }); await state.process.stdin.write(`${JSON.stringify({ ...command, id })}\n`); return Promise.race([promise, timeout(this.defaultTimeoutMs, `OMP RPC command timed out: ${String(command.type)}`)]); }
  private async silenceWatch(state: ProcessState, turn: AgentTurnRef, inactivityMs: number): Promise<AgentTurnResult> { while (state.pending.has(turn.turnId)) { await new Promise(resolve => setTimeout(resolve, Math.min(500, inactivityMs))); if (Date.now() - state.lastFrameAt >= inactivityMs) throw new Error(`OMP RPC inactivity exceeded ${inactivityMs}ms before turn deadline`); } throw new Error("OMP RPC turn completed without result"); }
  private state(handle: AgentSessionHandle): ProcessState { const state = this.processes.get(handle.transportId); if (!state) throw new Error("unknown OMP RPC transport"); return state; }
}
function textFromMessage(value: unknown): string { if (!value || typeof value !== "object" || !("role" in value) || value.role !== "assistant" || !("content" in value) || !Array.isArray(value.content)) return ""; return value.content.filter((item): item is { type: "text"; text: string } => Boolean(item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string")).map(item => item.text).join(""); }
function stateHandle(state: ProcessState): AgentSessionHandle { return { ref: state.ref, transportId: state.transportId, processId: state.process.pid }; }
function timeout(ms: number, message: string): Promise<never> { const { promise, reject } = Promise.withResolvers<never>(); const timer = setTimeout(() => reject(new Error(message)), ms); if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") timer.unref(); return promise; }
function isSessionState(value: unknown): value is { sessionId: string; sessionFile?: string } { if (!value || typeof value !== "object" || !("sessionId" in value) || typeof value.sessionId !== "string") return false; return !(("sessionFile" in value) && value.sessionFile !== undefined && typeof value.sessionFile !== "string"); }
function delay(ms: number): Promise<void> { return new Promise(resolve => { const timer = setTimeout(resolve, ms); if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") timer.unref(); }); }
async function drainStderr(stream: ReadableStream<Uint8Array>, path: string | undefined): Promise<void> { if (!path) return; await mkdir(dirname(path), { recursive: true }); const reader = stream.getReader(); const decoder = new TextDecoder(); while (true) { const { value, done } = await reader.read(); if (done) break; await appendFile(path, decoder.decode(value, { stream: true }), "utf8"); } }
