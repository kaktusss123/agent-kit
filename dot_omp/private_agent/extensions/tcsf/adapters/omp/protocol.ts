export interface RpcReadyFrame { type: "ready"; protocolVersion?: number; supportedProtocolVersions?: number[]; }
export interface RpcResponseFrame { type: "response"; id?: string; command: string; success: boolean; data?: unknown; error?: string; code?: string; }
export interface RpcAgentStartFrame { type: "agent_start"; }
export interface RpcAgentEndFrame { type: "agent_end"; isTerminal?: boolean; messages?: unknown[]; }
export interface RpcTurnEndFrame { type: "turn_end"; stopReason?: string; errorMessage?: string; }
export interface RpcMessageEndFrame { type: "message_end"; message?: unknown; }
export interface RpcToolFrame { type: "tool_execution_start" | "tool_execution_end"; toolName?: string; toolCallId?: string; }
export interface RpcExtensionUIRequestFrame { type: "extension_ui_request"; id: string; method: string; [key: string]: unknown; }
export type RpcFrame = RpcReadyFrame | RpcResponseFrame | RpcAgentStartFrame | RpcAgentEndFrame | RpcTurnEndFrame | RpcMessageEndFrame | RpcToolFrame | RpcExtensionUIRequestFrame;

export function decodeRpcLine(line: string): RpcFrame | null {
  if (!line.trim()) return null;
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (typeof value.type !== "string") return null;
    return value as RpcFrame;
  } catch { return null; }
}

export function isTerminalFrame(frame: RpcFrame): boolean {
  return frame.type === "agent_end" && frame.isTerminal !== false;
}
