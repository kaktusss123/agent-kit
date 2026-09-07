/**
 * workspace_agent — repo-rooted top-level SDK session bridge.
 *
 * Spawns a RepoOwner: a full stock OMP agent session rooted (cwd AND
 * SessionManager) in a managed task worktree, with the target repo's project
 * instructions delivered through the stock `discoverContextFiles` helper
 * (`.omp/AGENTS.md` shadows root `AGENTS.md`) and a strict structured
 * output contract (yield envelope validated in strict mode).
 *
 * Architecture contract:
 * - Public SDK only, accessed through the injected `pi.pi` namespace
 *   (createAgentSession, SessionManager.inMemory, AgentRegistry). No OMP core
 *   patch, no private runtime imports, no npm runtime dependency.
 * - Not a task replacement: stock "task" stays the delegation mechanism
 *   INSIDE the RepoOwner; nested helpers inherit the workspace because the
 *   whole child session is rooted there.
 * - Fail closed BEFORE dispatch: if a required capability, the workspace
 *   validation, or the session initialization fails, the tool returns
 *   status "unsupported" with dispatched=false and Main may degrade to
 *   stock "task" + explicit absolute managed-worktree paths.
 * - No fallback AFTER dispatch: the child may already have mutated the repo,
 *   so post-dispatch failures return "partial"/"blocked" with
 *   child_may_have_mutated_repo=true for Main to inspect and repair.
 * - The child loses exactly one tool: "workspace_agent" (no recursive
 *   workspace owners). "task" and everything else stay active.
 * - The child's extension runner is initialized, so tool_call hooks (the
 *   task-workspace mutation guard) fire inside RepoOwner sessions.
 * - Settlement mirrors the stock task semantics: a yield with pending async
 *   work is a scheduling pause, not completion — jobs are settled, delivered
 *   results invalidate the yield, and a fresh one is demanded until the run
 *   is quiescent or the deadline fires.
 */
import type {
  AgentSession,
  CreateAgentSessionResult,
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";

// ─── Workspace helpers (same semantics as task-workspace.ts) ────────────

function realpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // Non-existent paths (e.g. TASK_ROOT before its first workspace on a
    // fresh install) stay unresolved instead of throwing out of module init.
    return p;
  }
}

const TASK_ROOT = realpath(process.env.OMP_TASK_ROOT ?? join(homedir(), ".omp", "tasks"));

function expandPath(p: string, cwd: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolve(cwd, p);
}

function findGitRoot(start: string): string | null {
  let current = start;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = resolve(current, "..");
    if (parent === current) return null;
    current = parent;
  }
}

/** A linked worktree marks its membership with a .git FILE pointing at the
 *  repo's gitdir; the primary checkout has a .git directory instead. */
function isLinkedWorktree(repoRoot: string): boolean {
  try {
    const content = readFileSync(join(repoRoot, ".git"), "utf-8");
    return content.startsWith("gitdir:");
  } catch {
    return false;
  }
}

function underTaskRoot(p: string): boolean {
  return p.startsWith(TASK_ROOT + "/") || p === TASK_ROOT;
}

async function git(
  cwd: string,
  ...args: string[]
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

// ─── Project context of the target repo ─────────────────────────────────

/** Project context strategy (explicit compatibility contract):
 *
 *  1. Stock `discoverContextFiles(repoRoot)` is authoritative for native OMP
 *     context: `.omp/AGENTS.md` (which shadows root `AGENTS.md` in the same
 *     project scope). SYSTEM.md / CLAUDE.md / GEMINI.md and other editor
 *     conventions are never part of the contract.
 *  2. Known embedded-runtime gap: inside some host processes the helper
 *     misses the ROOT `AGENTS.md` of a linked worktree (deterministically
 *     returns nothing for it). Since a managed worktree IS the project root,
 *     the bridge adds root `AGENTS.md` explicitly as fallback whenever the
 *     native `.omp/AGENTS.md` was not found by discovery — priority stays
 *     with `.omp/AGENTS.md`, and no duplicate is added when discovery
 *     already returned the root file.
 *  3. A discovered/selected file that cannot be read fails the dispatch:
 *     a RepoOwner is never launched without the policy the framework
 *     expected to apply. */
async function collectProjectContext(
  sdk: { discoverContextFiles?: (cwd?: string) => Promise<unknown> },
  repoRoot: string,
): Promise<{ files: Array<{ path: string; content: string }>; error?: string }> {
  if (typeof sdk.discoverContextFiles !== "function") {
    return {
      files: [],
      error:
        "Public SDK capability discoverContextFiles is missing; refusing to dispatch without stock project-context discovery.",
    };
  }
  let discovered: unknown;
  try {
    discovered = await sdk.discoverContextFiles(repoRoot);
  } catch (e) {
    return {
      files: [],
      error: `discoverContextFiles(${repoRoot}) failed: ${(e as Error).message}`,
    };
  }
  const files = (
    Array.isArray(discovered) ? discovered : (discovered as { files?: unknown } | undefined)?.files
  ) as Array<{ path?: unknown; content?: unknown }> | undefined;
  if (!Array.isArray(files)) {
    return {
      files: [],
      error: "discoverContextFiles returned an unexpected shape; refusing to dispatch.",
    };
  }
  const out: Array<{ path: string; content: string }> = [];
  for (const f of files) {
    if (typeof f.path !== "string" || typeof f.content !== "string") {
      return {
        files: [],
        error: `discoverContextFiles returned an entry with unexpected shape: ${JSON.stringify(f).slice(0, 120)}`,
      };
    }
    out.push({ path: f.path, content: f.content });
  }
  const nativeAgents = join(repoRoot, ".omp", "AGENTS.md");
  const rootAgents = join(repoRoot, "AGENTS.md");
  const hasNative = out.some((f) => f.path === nativeAgents);
  const hasRoot = out.some((f) => f.path === rootAgents);
  if (!hasNative && !hasRoot && existsSync(rootAgents)) {
    try {
      out.push({ path: rootAgents, content: await readFile(rootAgents, "utf-8") });
    } catch (e) {
      return {
        files: [],
        error: `Project instruction file ${rootAgents} exists but cannot be read: ${(e as Error).message}. Refusing to dispatch a RepoOwner without the policy the framework expected to apply.`,
      };
    }
  }
  return { files: out };
}

// ─── Structured output contract ─────────────────────────────────────────

const REPO_OWNER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "verification", "gaps"],
  properties: {
    status: { type: "string", enum: ["done", "partial", "blocked"] },
    summary: { type: "string" },
    verification: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["check", "result"],
        properties: {
          check: { type: "string" },
          result: { type: "string", enum: ["pass", "fail", "blocked"] },
        },
      },
    },
    gaps: { type: "array", items: { type: "string" } },
  },
} as const;

interface RepoOwnerEnvelope {
  status: "done" | "partial" | "blocked";
  summary: string;
  verification: Array<{ check: string; result: string }>;
  gaps: string[];
}

function isValidEnvelope(data: unknown): data is RepoOwnerEnvelope {
  if (typeof data !== "object" || data === null) return false;
  const rec = data as Record<string, unknown>;
  if (rec.status !== "done" && rec.status !== "partial" && rec.status !== "blocked") return false;
  if (typeof rec.summary !== "string") return false;
  if (!Array.isArray(rec.verification) || !Array.isArray(rec.gaps)) return false;
  return true;
}

const MAX_YIELD_RETRIES = 3;

function yieldReminder(retry: number, max: number): string {
  return [
    "Your structured result has not been submitted yet.",
    `Call the \`yield\` tool now with the final JSON envelope: {"status": "done"|"partial"|"blocked", "summary": string, "verification": [{"check", "result"}], "gaps": [string]}.`,
    `Reminder ${retry} of ${max}.`,
  ].join(" ");
}

/** Provider-aware named tool choice for the final ladder retry (mirrors the
 *  stock task driver's forcing behavior). */
function namedYieldToolChoice(
  model: { api?: string } | undefined,
): { type: "tool"; name: string } | { type: "function"; name: string } | "required" | undefined {
  if (!model?.api) return undefined;
  if (model.api === "anthropic-messages" || model.api === "bedrock-converse-stream") {
    return { type: "tool", name: "yield" };
  }
  if (
    model.api === "openai-codex-responses" ||
    model.api === "openai-responses" ||
    model.api === "openai-completions" ||
    model.api === "azure-openai-responses" ||
    model.api === "ollama-chat"
  ) {
    return { type: "function", name: "yield" };
  }
  if (model.api.startsWith("google-")) return "required";
  return undefined;
}

// ─── Extension entry point ──────────────────────────────────────────────
export default function (pi: ExtensionAPI): void {
  const tb = pi.typebox.Type;
  pi.registerTool({
    name: "workspace_agent",
    label: "Workspace Agent",
    description:
      "Spawn a RepoOwner: a full stock OMP agent session rooted in a managed task worktree (workspace must be the absolute canonical worktree path). The child writes with relative paths, sees the target repo's project instructions, can use stock task helpers rooted in the same worktree, and must finish with a strict structured yield envelope {status, summary, verification, gaps}. Pre-dispatch incompatibilities return status 'unsupported' with dispatched=false (safe to degrade to stock task + absolute paths). After dispatch there is never an automatic fallback — failures return 'partial'/'blocked' with child_may_have_mutated_repo=true.",
    parameters: tb.Object({
      workspace: tb.String({
        description:
          "Absolute canonical path of the managed task worktree to root the RepoOwner in",
      }),
      task: tb.String({
        description:
          "Complete RepoOwner assignment: goal, contract, verification expectations",
      }),
      timeout_ms: tb.Optional(
        tb.Number({
          description:
            "Internal deadline in milliseconds (default 600000); on timeout the child is aborted and disposed",
        }),
      ),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const finish = (
        payload: Record<string, unknown>,
      ): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } => ({
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        details: payload,
      });

      try {
        // 0. Capability check against the PUBLIC SDK surface — fail closed
        const sdk = pi.pi as typeof pi.pi | undefined;
        if (
          !sdk ||
          typeof sdk.createAgentSession !== "function" ||
          typeof sdk.SessionManager?.inMemory !== "function" ||
          typeof sdk.AgentRegistry !== "function" ||
          typeof sdk.discoverContextFiles !== "function"
        ) {
          return finish({
            status: "unsupported",
            dispatched: false,
            reason:
              "Required public SDK capabilities are missing from pi.pi (createAgentSession, SessionManager.inMemory, AgentRegistry). Degrade to stock task with explicit absolute managed-worktree paths.",
          });
        }

        // 1. Model: pin the child to the orchestrator's active model. Fail
        // before dispatch rather than silently picking a different default.
        const model = ctx.model;
        const modelRegistry = ctx.modelRegistry;
        if (!model) {
          return finish({
            status: "blocked",
            dispatched: false,
            reason: "No active model is available through the public extension context; refusing to dispatch with an unpredictable model",
          });
        }

        // 2. Workspace validation — everything pre-dispatch.
        const cwd = realpath(ctx.cwd);
        const wsAbs = expandPath(params.workspace, cwd);
        let ws: string;
        try {
          ws = realpath(wsAbs);
        } catch {
          return finish({
            status: "unsupported",
            dispatched: false,
            reason: `Workspace does not exist: ${wsAbs}`,
          });
        }
        if (!isLinkedWorktree(ws)) {
          return finish({
            status: "unsupported",
            dispatched: false,
            reason: `Workspace ${ws} is not a linked git worktree (primary checkouts are never valid workspace_agent targets)`,
          });
        }
        if (!underTaskRoot(ws)) {
          return finish({
            status: "unsupported",
            dispatched: false,
            reason: `Workspace ${ws} is not a managed task worktree under ${TASK_ROOT}`,
          });
        }
        const top = await git(ws, "rev-parse", "--show-toplevel");
        const canonicalRoot = top.ok ? realpath(top.stdout) : "";
        if (!top.ok || canonicalRoot !== ws) {
          return finish({
            status: "unsupported",
            dispatched: false,
            reason: `Canonical repo root (${canonicalRoot || top.stderr || "unresolvable"}) does not match the requested workspace root ${ws}`,
          });
        }

        // 3. Project context of the TARGET repo via the stock discovery helper.
        // Passing contextFiles suppresses automatic discovery, so no context
        // from the orchestrator's repo can leak and none of the target's own
        // policy (including .omp/AGENTS.md shadowing rules) is missed.
        const context = await collectProjectContext(sdk, ws);
        if (context.error) {
          return finish({ status: "unsupported", dispatched: false, reason: context.error });
        }

        const timeoutMs = params.timeout_ms ?? 600_000;
        const deadlineSignal = AbortSignal.timeout(timeoutMs);
        const abortSignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;

        // 5. Child session: in-memory, privately registered, rooted twice.
        const sessionManager = sdk.SessionManager.inMemory(ws);
        let session: AgentSession | undefined;
        const onAbort = (): void => {
          void session?.abort({ reason: "workspace_agent deadline or parent abort" }).catch(() => {});
        };
        abortSignal.addEventListener("abort", onAbort, { once: true });

        const abortable = async <T>(p: Promise<T>): Promise<T> => {
          if (abortSignal.aborted) throw new Error("aborted before completion");
          const abortPromise = new Promise<never>((_resolve, reject) => {
            abortSignal.addEventListener("abort", () => reject(new Error("aborted before completion")), { once: true });
          });
          return await Promise.race([p, abortPromise]);
        };

        let unsub: (() => void) | undefined;
        try {
          let created: CreateAgentSessionResult;
          try {
            created = await sdk.createAgentSession({
              cwd: ws,
              sessionManager,
              agentRegistry: new sdk.AgentRegistry(),
              model,
              modelRegistry,
              contextFiles: context.files,
              outputSchema: REPO_OWNER_OUTPUT_SCHEMA,
              outputSchemaMode: "strict",
              requireYieldTool: true,
              autoApprove: true,
              hasUI: false,
              agentName: "RepoOwner",
            });
          } catch (e) {
            return finish({
              status: "unsupported",
              dispatched: false,
              reason: `SDK session initialization failed: ${(e as Error).message}. Nothing was dispatched; degrade to stock task with explicit absolute paths.`,
            });
          }
          session = created.session;
          if (abortSignal.aborted) {
            return finish({
              status: "blocked",
              dispatched: false,
              reason: "Aborted before the assignment was dispatched",
            });
          }

          // 6. Root invariant — mandatory safety check, not a diagnostic.
          const sessionCwd = session.sessionManager.getCwd();
          if (realpath(sessionCwd) !== ws) {
            return finish({
              status: "unsupported",
              dispatched: false,
              reason: `Root invariant failed: session cwd ${sessionCwd} != workspace ${ws}. Assignment not dispatched.`,
            });
          }

          // 7. RepoOwner must not spawn further workspace owners; everything
          // else (notably stock "task" and the task-workspace tools) stays.
          // Awaited: session_start handlers must observe the filtered set.
          await session.setActiveToolsByName(
            session.getEnabledToolNames().filter((n) => n !== "workspace_agent"),
          );

          // 8. Initialize the child's extension runner (pre-init runners never
          // fire tool_call hooks — the mutation guard would be dead) and emit
          // session_start exactly like the stock task spawner does.
          const runner = session.extensionRunner;
          if (runner) {
            const pendingExtensionMessages: Array<Promise<unknown>> = [];
            runner.initialize(
              {
                sendMessage: (message, options) => {
                  pendingExtensionMessages.push(
                    session!.sendCustomMessage(message, options).catch(() => {}),
                  );
                },
                sendUserMessage: (content, options) => {
                  pendingExtensionMessages.push(
                    session!.sendUserMessage(content, options).catch(() => {}),
                  );
                },
                appendEntry: (customType, data) => {
                  session!.sessionManager.appendCustomEntry(customType, data);
                },
                setLabel: (targetId, label) => {
                  session!.sessionManager.appendLabelChange(targetId, label);
                },
                getActiveTools: () => session!.getEnabledToolNames(),
                getAllTools: () => session!.getAllToolInfos(),
                setActiveTools: (toolNames: string[]) =>
                  session!.setActiveToolsByName(
                    toolNames.filter((n) => n !== "workspace_agent"),
                  ),
                getCommands: () => [],
                setModel: () => Promise.resolve(false),
                getThinkingLevel: () => session!.thinkingLevel,
                setThinkingLevel: (level) => session!.setThinkingLevel(level),
                getServiceTiers: () => ({}),
                setServiceTier: () => {},
                getSessionName: () => session!.sessionManager.getSessionName(),
                setSessionName: async (name) => {
                  await session!.sessionManager.setSessionName(name, "user");
                },
              },
              {
                getModel: () => session!.model,
                isIdle: () => !session!.isStreaming,
                abort: () => session!.abort({ reason: "extension requested abort" }),
                hasPendingMessages: () => session!.queuedMessageCount > 0,
                shutdown: () => {},
                getContextUsage: () => session!.getContextUsage(),
                getSystemPrompt: () => session!.systemPrompt,
                compact: () => Promise.resolve(),
              },
            );
            runner.onError(() => {});
            await runner.emit({ type: "session_start" });
            await Promise.all(pendingExtensionMessages);
          }

          // 9. Yield capture off the child's own event stream.
          let captured: { data: unknown } | undefined;
          unsub = session.subscribe((event) => {
            if (event.type !== "tool_execution_end" || event.toolName !== "yield") return;
            const details = (
              event as { result?: { details?: { status?: unknown; data?: unknown; type?: unknown; complete?: unknown } } }
            ).result?.details;
            if (!details || details.status === "aborted") return;
            const incremental = Array.isArray(details.type) && details.type.length > 0;
            if (incremental && details.complete !== true) return; // progress yield, not terminal
            if (details.status === "success") captured = { data: details.data };
          });

          // 10. Drive to a quiescent structured yield (stock task settlement
          // semantics: pending async work parks a yield; delivered results
          // invalidate it and a fresh one is demanded).
          let ladderRetries = 0;
          let modelError = false;
          let driveError: string | undefined;
          try {
            await abortable(session.prompt(params.task, { attribution: "agent" }));
            await abortable(session.waitForIdle());
            for (;;) {
              if (abortSignal.aborted) throw new Error("deadline");
              if (captured && !session.hasPendingAsyncWork()) break;
              if (captured) {
                // Yield parked behind async jobs: settle, invalidate the stale
                // yield, and demand a fresh one that accounts for the results.
                await abortable(session.settleAsyncWork());
                captured = undefined;
                ladderRetries = 0;
                continue;
              }
              const last = session.getLastAssistantMessage();
              if (last?.stopReason === "error") {
                modelError = true;
                break;
              }
              if (ladderRetries >= MAX_YIELD_RETRIES) break;
              ladderRetries++;
              const isFinalRetry = ladderRetries >= MAX_YIELD_RETRIES;
              await abortable(
                session.prompt(yieldReminder(ladderRetries, MAX_YIELD_RETRIES), {
                  attribution: "agent",
                  synthetic: true,
                  ...(isFinalRetry ? { toolChoice: namedYieldToolChoice(model) } : {}),
                }),
              );
              await abortable(session.waitForIdle());
            }
          } catch (e) {
            driveError = (e as Error).message;
          }

          // 11. Classification — no automatic fallback past this point.
          const lastAssistant = session.getLastAssistantMessage();
          const salvage =
            lastAssistant?.content
              ?.map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
              .filter(Boolean)
              .join("\n")
              .trim() ?? undefined;

          if (captured && isValidEnvelope(captured.data)) {
            return finish({
              status: "done",
              dispatched: true,
              workspace: ws,
              result: captured.data,
            });
          }
          if (captured) {
            return finish({
              status: "blocked",
              dispatched: true,
              workspace: ws,
              child_may_have_mutated_repo: true,
              reason: "RepoOwner produced a structured result that failed envelope validation",
              raw_result: captured.data,
              last_output: salvage,
            });
          }
          const timedOut = deadlineSignal.aborted;
          return finish({
            status: timedOut ? "partial" : "blocked",
            dispatched: true,
            workspace: ws,
            child_may_have_mutated_repo: true,
            reason: timedOut
              ? `Deadline (${timeoutMs}ms) fired before a quiescent structured yield; the child was aborted and disposed and the repository may contain partial changes.`
              : modelError
                ? "RepoOwner ended with a terminal model error before submitting a valid structured yield."
                : `No valid structured yield after ${MAX_YIELD_RETRIES} reminders${driveError ? ` (last drive error: ${driveError})` : ""}. Inspect the worktree and repair with a fresh workspace_agent invocation.`,
            last_output: salvage,
          });
        } finally {
          unsub?.();
          abortSignal.removeEventListener("abort", onAbort);
          try {
            await session?.dispose();
          } catch {
            // dispose is idempotent; a failure here must not mask the result
          }
        }
      } catch (e) {
        return finish({
          status: "error",
          dispatched: false,
          reason: (e as Error).message,
        });
      }
    },
  });
}
