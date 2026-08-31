import type { AgentSessionHandle, AgentSessionRef, AgentSessionStatus, AgentTurnRef, AgentTurnResult } from "../core/types.ts";

export interface CreateAgentSessionInput {
  cwd: string;
  workspaceRoots: string[];
  readOnlyRoots: string[];
  systemPrompt: string;
  role: "implementer" | "reviewer" | "candidate-validator";
  sessionDirectory?: string;
  model?: string;
  noTools?: boolean;
}
export interface AgentTurnInput { prompt: string; timeoutMs?: number; logicalTurnId?: string; contentHash?: string; }
export interface AgentRuntime {
  readonly kind: string;
  createSession(input: CreateAgentSessionInput): Promise<AgentSessionRef>;
  resumeSession(ref: AgentSessionRef): Promise<AgentSessionHandle>;
  sendTurn(handle: AgentSessionHandle, input: AgentTurnInput): Promise<AgentTurnRef>;
  waitForTurn(handle: AgentSessionHandle, turn: AgentTurnRef): Promise<AgentTurnResult>;
  reconcileTurn?(ref: AgentSessionRef, input: { logicalTurnId: string; prompt: string; contentHash: string }): Promise<"completed" | "not_accepted" | "unknown">;
  interruptTurn(handle: AgentSessionHandle, turn: AgentTurnRef): Promise<void>;
  inspectSession(ref: AgentSessionRef): Promise<AgentSessionStatus>;
  close(handle: AgentSessionHandle): Promise<void>;
}
