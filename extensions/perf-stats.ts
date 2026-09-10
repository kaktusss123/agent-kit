/**
 * Perf Stats - shows time to first token (TTFT) and tokens per second (TPS)
 * under each assistant message, and execution time under each tool call.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/* Formatting */

function fmtTime(ms: number): string {
  if (ms < 1000) return ms + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  const min = Math.floor(ms / 60000);
  const sec = Math.round((ms % 60000) / 1000);
  return min + "m " + sec + "s";
}

function fmtTokens(n: number): string {
  if (n < 1000) return "" + n;
  return (n / 1000).toFixed(1) + "k";
}

/* Types */

interface TextPerfStats {
  kind: "text";
  ttftMs: number;
  tps: number;
  outputTokens: number;
}

interface ToolPerfStats {
  kind: "tool";
  toolName: string;
  execTimeMs: number;
}

type PerfStats = TextPerfStats | ToolPerfStats;

/* Extension */

export default function (pi: ExtensionAPI) {
  let msgStart = 0;
  let msgFirstToken = 0;
  const toolStarts = new Map<string, number>();

  pi.on("message_start", async (_event) => {
    if (_event.message.role === "assistant") {
      msgStart = Date.now();
      msgFirstToken = 0;
    }
  });

  pi.on("message_update", async (_event) => {
    if (msgFirstToken > 0) return;
    if (_event.assistantMessageEvent.type === "text_delta") {
      msgFirstToken = Date.now();
    }
  });

  pi.on("message_end", async (_event) => {
    if (_event.message.role !== "assistant") return;
    if (msgStart === 0) return;

    const endTime = Date.now();
    const msg = _event.message as { usage?: { output?: number } };
    const outputTokens: number = msg.usage?.output ?? 0;

    const ttftMs = msgFirstToken > 0
      ? msgFirstToken - msgStart
      : endTime - msgStart;

    let tps = 0;
    const genTimeSec = msgFirstToken > 0
      ? (endTime - msgFirstToken) / 1000
      : (endTime - msgStart) / 1000;
    if (genTimeSec > 0 && outputTokens > 0) {
      tps = outputTokens / genTimeSec;
    }

    if (outputTokens > 0 || ttftMs > 0) {
      pi.appendEntry("perf-stats", {
        kind: "text", ttftMs, tps, outputTokens
      });
    }

    msgStart = 0;
    msgFirstToken = 0;
  });

  pi.on("tool_execution_start", async (_event) => {
    toolStarts.set(_event.toolCallId, Date.now());
  });

  pi.on("tool_execution_end", async (_event) => {
    const start = toolStarts.get(_event.toolCallId);
    toolStarts.delete(_event.toolCallId);
    if (start !== undefined) {
      pi.appendEntry("perf-stats", {
        kind: "tool", toolName: _event.toolName, execTimeMs: Date.now() - start
      });
    }
  });

  pi.registerEntryRenderer<PerfStats>("perf-stats", (entry, _opts, theme) => {
    const data = entry.data;
    if (!data) return new Text("", 0, 0);

    const dim = (s: string) => theme.fg("dim", s);

    if (data.kind === "text") {
      const parts: string[] = [];
      const label = data.ttftMs < 1000
        ? "<1s TTFT"
        : fmtTime(data.ttftMs) + " TTFT";
      parts.push(dim(label));

      if (data.tps > 0) {
        parts.push(dim(fmtTokens(Math.round(data.tps)) + " tok/s"));
      }
      if (data.outputTokens > 0) {
        parts.push(dim(fmtTokens(data.outputTokens) + " tok"));
      }

      return new Text("  " + parts.join(" · "), 0, 0);
    }

    if (data.kind === "tool") {
      return new Text("  " + dim(data.toolName + ": " + fmtTime(data.execTimeMs)), 0, 0);
    }

    return new Text("", 0, 0);
  });
};
