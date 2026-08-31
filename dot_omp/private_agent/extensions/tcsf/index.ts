import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createDefaultFactory } from "./runner.ts";
import { registerTcsfCommands } from "./bindings/commands.ts";
import { registerTcsfTools } from "./bindings/tools.ts";

function lexicalContained(root: string, child: string): boolean { const base = resolve(root); const target = resolve(root, child); return target === base || target.startsWith(`${base}/`); }
async function physicallyContained(root: string, child: string): Promise<boolean> {
  if (!child || child.includes("\0") || !lexicalContained(root, child)) return false;
  const base = resolve(root); let realBase = base; try { realBase = await realpath(base); } catch {}
  let current = resolve(root, child);
  while (true) {
    try { const actual = await realpath(current); return actual === realBase || actual.startsWith(`${realBase}/`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || current === base) return false; current = dirname(current); }
  }
}
function targetFromInput(input: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file_path", "filePath", "target"]) if (typeof input[key] === "string") return input[key];
  return undefined;
}

export default function registerTcsf(pi: ExtensionAPI): void {
  const root = process.env.TCSF_HOME ?? `${process.env.HOME ?? "."}/.omp/tcsf`;
  const factory = createDefaultFactory(root, message => pi.logger.warn(message));
  registerTcsfCommands(pi, factory); registerTcsfTools(pi, factory);
  try { const tcsfTools = pi.getAllTools().filter(tool => tool.name.startsWith("tcsf_")).map(tool => tool.name); const duplicateTools = tcsfTools.filter((name, index) => tcsfTools.indexOf(name) !== index); pi.logger.info(`[tcsf] registry tools=${JSON.stringify(tcsfTools)} duplicateTools=${JSON.stringify(duplicateTools)}`); const registryPath = process.env.TCSF_CANDIDATE_REGISTRY_PATH; if (registryPath) void Bun.write(registryPath, `${JSON.stringify({ tools: tcsfTools, duplicateTools })}\n`); } catch (error) { pi.logger.warn(`[tcsf] registry unavailable: ${String(error)}`); }
  pi.on("session_shutdown", async () => { try { const tcsfTools = pi.getAllTools().filter(tool => tool.name.startsWith("tcsf_")).map(tool => tool.name); const duplicateTools = tcsfTools.filter((name, index) => tcsfTools.indexOf(name) !== index); pi.logger.info(`[tcsf] registry tools=${JSON.stringify(tcsfTools)} duplicateTools=${JSON.stringify(duplicateTools)}`); } catch (error) { pi.logger.warn(`[tcsf] registry unavailable: ${String(error)}`); } });
  pi.on("session_start", async () => { const registryPath = process.env.TCSF_CANDIDATE_REGISTRY_PATH; if (!registryPath) return; try { const tcsfTools = pi.getAllTools().filter(tool => tool.name.startsWith("tcsf_")).map(tool => tool.name); const duplicateTools = tcsfTools.filter((name, index) => tcsfTools.indexOf(name) !== index); await Bun.write(registryPath, `${JSON.stringify({ tools: tcsfTools, duplicateTools })}\n`); } catch (error) { pi.logger.warn(`[tcsf] registry unavailable: ${String(error)}`); } });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const target = targetFromInput(event.input); if (!target) return { block: true, reason: "TCSF write policy requires an explicit target path" };
    if (!(await physicallyContained(ctx.cwd, target))) return { block: true, reason: `TCSF write denied outside current workspace: ${target}` };
    return undefined;
  });
  pi.logger.info("[tcsf] loaded");
}
