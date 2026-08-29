import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { isValidTaskId, snapshotHandoffPath } from "./paths.ts";
import { attachRepoToTask, reopenTask, taskStatus, prepareWorktrees, buildHandoff } from "./lifecycle";
import { createTaskForInit, approveAndPrepareHandoff, startImplementationForHandoff } from "./tools.ts";
import { loadManifest } from "./storage.ts";

const TYPES = ["feat", "fix", "chore", "refactor", "test"] as const;
const ROLES = ["target", "reference"] as const;

export function registerTaskRuntimeCommands(pi: ExtensionAPI): void {
  const exec = async (cmd: string, args: string[], options?: { cwd?: string }) => {
    const r = await pi.exec(cmd, args, options);
    return { code: r.code, stdout: r.stdout, stdout: r.stderr, stderr: r.stderr };
  };

  pi.registerCommand("task_init", {
    description: "/task_init — interactive: pick type, enter id, describe the task",
    async handler(_args, ctx) {
      if (!ctx.hasUI) { ctx.ui.notify("task_init requires a TUI session", "error"); return; }
      const type = await ctx.ui.select("Task type", TYPES.slice());
      if (!type) { ctx.ui.notify("task_init cancelled", "info"); return; }
      const idRaw = await ctx.ui.input(`Task id (${type})`, "kebab/snake id, e.g. fix-logging");
      if (idRaw === undefined) { ctx.ui.notify("task_init cancelled", "info"); return; }
      const id = idRaw.trim();
      if (!isValidTaskId(id)) {
        ctx.ui.notify(`invalid id "${id}": 2+ chars, letters/digits/-/_ only`, "error");
        return;
      }
      const descRaw = await ctx.ui.input(`Describe task ${id}`, "What is this task for?");
      if (descRaw === undefined) { ctx.ui.notify("task_init cancelled", "info"); return; }
      const description = descRaw.trim();

      const git = await exec("git", ["-C", ctx.cwd, "rev-parse", "--show-toplevel"]);
      if (git.code !== 0) { ctx.ui.notify(`not a git repo: ${ctx.cwd}`, "error"); return; }
      const primary = git.stdout.trim();
      const oldSession = ctx.sessionManager.getSessionFile();
      let worktreePath: string | undefined;
      try {
        const result = await createTaskForInit({
          pi, taskId: id, type: type as typeof TYPES[number],
          primarySourcePath: primary,
          ...(description ? { description } : {}),
          crackerSessionFile: oldSession,
        });
        // §1 step 8-9: move cracker into the task worktree.
        // This spawns a new TUI foreground session with cwd=worktree,
        // keeping the source-checkout session as parent/background.
        worktreePath = result.worktreePath;
        if (worktreePath) {
          const moved = await ctx.newSession({
            parentSession: oldSession,
            setup: async (sm) => { await sm.moveTo(worktreePath!); },
          });
          if (moved.cancelled) { ctx.ui.notify("move cancelled", "warning"); return; }
          const newSession = ctx.sessionManager.getSessionFile();
          if (newSession && newSession !== oldSession) {
            const m = await loadManifest(id);
            m.sessions.cracker = {
              sessionFile: newSession,
              role: "cracker",
              createdAt: m.sessions.cracker!.createdAt!,
            };
            m.updatedAt = new Date().toISOString();
            await (await import("./storage.ts")).saveManifest(m);
          }
        }
      } catch (e) { ctx.ui.notify((e as Error).message, "error"); return; }

      await ctx.waitForIdle();
      const primaryName = primary.split("/").filter(Boolean).pop() ?? primary;
      const boot = [
        `skill://cracker`,
        `Task **${id}** (type: ${type}). Primary: **${primaryName}**.`,
        `Worktree: **${worktreePath}** (clean detached @ recorded HEAD).`,
        description ? `\nDescription: ${description}` : `\nDescription was left empty — ask the user in chat what they want, then analyze.`,
        `\nUse \`task_attach_repo\` for additional repos. When ready, call \`task_mark_ready\`.`,
        `Then tell user: /task_approve ${id} ; /task_handoff ${id}`,
      ].filter(Boolean).join("\n");
      pi.sendUserMessage(boot, { deliverAs: "steer" });
    },
  });

  pi.registerCommand("task_add_repo", {
    description: "/task_add_repo <id> <path> [target|reference]",
    getArgumentCompletions: (arg) => {
      const trailing = arg.length > 0 && arg.endsWith(" ") && arg.trim().length > 0;
      const tokens = arg.trim() ? arg.trim().split(/\s+/) : [];
      const last = trailing ? "" : (tokens[tokens.length - 1] ?? "");
      const onRoleArg = (tokens.length === 2 && trailing) || (tokens.length === 3 && !trailing);
      if (!onRoleArg) return null;
      return (last ? ROLES.filter(r => r.startsWith(last)) : ROLES.slice()).map(v => ({ value: v, label: v }));
    },
    async handler(args, ctx) {
      const t = args.trim().split(/\s+/); const id = t[0];
      const raw = t.slice(1, -1).join(" "); const last = t[t.length - 1];
      const isRole = (s: string): s is typeof ROLES[number] => (ROLES as readonly string[]).includes(s);
      const role = isRole(last) ? last : "target";
      const path = isRole(last) ? raw : args.trim().split(/\s+/).slice(1).join(" ");
      if (!id || !path || !isValidTaskId(id)) { ctx.ui.notify("bad args", "error"); return; }
      try { await attachRepoToTask({ exec, taskId: id, rawPath: path, role }); }
      catch (e) { ctx.ui.notify((e as Error).message, "error"); return; }
      ctx.ui.notify(`attached ${path.split("/").pop()} (${role})`, "info");
    },
  });

  pi.registerCommand("task_status", {
    description: "/task_status <id> — compact task status",
    async handler(args, ctx) {
      const id = args.trim().split(/\s+/)[0];
      if (!id || !isValidTaskId(id)) { ctx.ui.notify("bad id", "error"); return; }
      try { ctx.ui.notify(JSON.stringify(await taskStatus(id), null, 2), "info"); }
      catch (e) { ctx.ui.notify((e as Error).message, "error"); }
    },
  });

  pi.registerCommand("task_approve", {
    description: "/task_approve <id> — readiness check, freeze contract",
    async handler(args, ctx) {
      const id = args.trim().split(/\s+/)[0];
      if (!id || !isValidTaskId(id)) { ctx.ui.notify("bad id", "error"); return; }
      try {
        const r = await approveAndPrepareHandoff({ pi, taskId: id });
        ctx.ui.notify(`approved ${id} approval=${r.approvalId} — contract frozen.\nNow: /task_handoff ${id}`, "info");
      } catch (e) { ctx.ui.notify(`approval refused: ${(e as Error).message}`, "error"); }
    },
  });

  pi.registerCommand("task_handoff", {
    description: "/task_handoff <id> — start implementation in fresh foreground session",
    async handler(args, ctx) {
      const id = args.trim().split(/\s+/)[0];
      if (!id || !isValidTaskId(id)) { ctx.ui.notify("bad id", "error"); return; }
      let manifest;
      try { manifest = await loadManifest(id); }
      catch (e) { ctx.ui.notify((e as Error).message, "error"); return; }
      if (!manifest.approval) { ctx.ui.notify("no approval — run /task_approve first", "error"); return; }
      const primary = manifest.repos[manifest.primaryRepo];
      if (!primary?.worktreePath) { ctx.ui.notify("no worktree — corrupted task state", "error"); return; }
      const handoffPath = snapshotHandoffPath(id, manifest.approval.id);

      // §8: switch existing detached worktrees to task branch.
      try {
        await prepareWorktrees({ taskId: id, exec });
        await buildHandoff({ taskId: id, approvalId: manifest.approval.id });
      } catch (e) {
        ctx.ui.notify(`handoff prep: ${(e as Error).message}`, "error");
        return;
      }

      await ctx.waitForIdle();
      const parent = ctx.sessionManager.getSessionFile();
      if (!parent) { ctx.ui.notify("no parent session", "error"); return; }
      const result = await ctx.newSession({
        parentSession: parent,
        setup: async (sm) => {
          await sm.moveTo(primary.worktreePath!);
          for (const repo of Object.values(manifest.repos)) {
            if (repo.role !== "reference" && repo.worktreePath && repo.worktreePath !== primary.worktreePath) {
              sm.addWorkspaceDirectory(repo.worktreePath);
            }
          }
        },
      });
      if (result.cancelled) { ctx.ui.notify("handoff cancelled", "warning"); return; }

      const newSf = ctx.sessionManager.getSessionFile();
      if (!newSf) {
        ctx.ui.notify("handoff: new session file unavailable — retry /task_handoff " + id, "warning");
        return;
      }
      if (newSf === parent) {
        ctx.ui.notify("handoff: session not yet reflected — retry /task_handoff " + id, "warning");
        return;
      }
      try {
        await startImplementationForHandoff({
          taskId: id,
          approvalId: manifest.approval.id,
          implementerSessionFile: newSf,
          pi,
        });
      } catch (e) {
        ctx.ui.notify(`bind error: ${(e as Error).message}`, "error");
        return;
      }
      pi.sendUserMessage(`skill://implementer\n\nTask handoff: ${handoffPath}`);
    },
  });

  pi.registerCommand("task_reopen", {
    description: "/task_reopen <id> — return approved/implementing/blocked to discovery",
    async handler(args, ctx) {
      const id = args.trim().split(/\s+/)[0];
      if (!id || !isValidTaskId(id)) { ctx.ui.notify("bad id", "error"); return; }
      try { await reopenTask(id); ctx.ui.notify(`reopened ${id}`, "info"); }
      catch (e) { ctx.ui.notify((e as Error).message, "error"); }
    },
  });
}
