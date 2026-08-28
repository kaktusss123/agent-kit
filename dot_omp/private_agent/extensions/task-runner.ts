import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { mkdir } from "node:fs/promises";

const TASK_ROOT = Bun.env.HOME + "/.omp/tasks";
const TYPES = ["feat", "fix", "chore", "refactor", "test"];
const ROLES = ["primary", "target", "reference"];

type RepoEntry = {
  path: string; role: string; baseSha?: string;
  worktreeCreated?: boolean; branch?: string; worktreePath?: string;
};

type Manifest = {
  id: string; type: string; phase: string; primary: string;
  description?: string;
  repos: Record<string, RepoEntry>; specPath: string;
  approvedSpecHash: string | null; snapshotHash: string | null; createdAt: string;
};

function validId(s: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9_-]+$/.test(s) && s.length >= 2; }

// Autocomplete: deliberately NOT implemented for extension commands.
// `getArgumentCompletions` in omp v18.x is unusable for multi-token commands:
// 1. It fires on every alphanumeric keystroke in an argument position, so the
//    dropdown opens while the user is still typing the current token.
// 2. Accepting an item replaces the ENTIRE argument text (items are plain
//    `{value,label}` — no per-token range control). Enter-to-submit while the
//    dropdown is open therefore rewrites the input instead of sending it.
//    Observed live (v18.0.9): `/task_add_repo <id> <path> reference`
//    collapsed to `/task_add_repo reference` on Enter; the command never ran.
// 3. The command-registry builder hardcodes `input: { hint: "arguments" }`
//    and reads only `name`/`description`, so no gray placeholder is possible
//    (built-ins use `inlineHint`/`acpInputHint`).
// 4. The `/advisor`-style dropdown is `subcommands` on built-in definitions;
//    extensions cannot provide it.
// Until the editor API supports per-token completion ranges, role autocomplete
// is net-harmful (the role token is optional and typed manually anyway).
async function loadManifest(id: string): Promise<Manifest | null> {
  try { return await Bun.file(TASK_ROOT + "/" + id + "/manifest.json").json(); } catch { return null; }
}
async function saveManifest(id: string, m: Manifest): Promise<void> {
  const dir = TASK_ROOT + "/" + id;
  await mkdir(dir, { recursive: true });
  await Bun.write(dir + "/manifest.json", JSON.stringify(m, null, 2));
}
async function specHash(p: string): Promise<string> {
  return (await Bun.$`shasum -a 256 ${p}`.quiet()).text().trim().split(/\s+/)[0];
}
async function repoClean(pi: ExtensionAPI, repoPath: string, allowPath: string): Promise<{ clean: boolean }> {
  const r = await pi.exec("git", ["-C", repoPath, "status", "-u", "--porcelain"], { cwd: repoPath });
  if (r.code !== 0) return { clean: false };
  const bad = r.stdout.trim().split("\n").filter(l => {
    const p = (l.trim().split(/\s+/, 2)[1] || "");
    return p && p !== allowPath && p !== "__none__";
  });
  return { clean: bad.length === 0 };
}

export default function (pi: ExtensionAPI) {

  pi.registerCommand("task_init", {
    description: "/task_init — interactive: pick type, enter id, describe the task",
    async handler(args, ctx) {
      if (args.trim()) {
        ctx.ui.notify("task_init takes no arguments — run /task_init and answer the dialogs", "warning");
      }
      // Headless invocations (RPC mode, scripting) cannot surface dialogs.
      if (!ctx.hasUI) {
        ctx.ui.notify("task_init requires a TUI session for its dialogs", "error");
        return;
      }
      // Dialog-driven flow: nothing is written to `~/.omp/tasks/<id>/` and no
      // cracker prompt is fired until every dialog is answered. Cancelled or
      // empty input at any step aborts cleanly, so the agent never receives
      // a description-less task.
      const type = await ctx.ui.select("Task type", TYPES);
      if (type === undefined) { ctx.ui.notify("task_init cancelled", "info"); return; }

      const idRaw = await ctx.ui.input(`Task id (${type})`, "kebab/snake id, e.g. fix-logging");
      if (idRaw === undefined) { ctx.ui.notify("task_init cancelled", "info"); return; }
      const id = idRaw.trim();
      if (!validId(id)) {
        ctx.ui.notify("invalid id '" + id + "': 2+ chars, letters/digits/-/_ only", "error");
        return;
      }
      if (await loadManifest(id)) {
        ctx.ui.notify("task '" + id + "' already exists", "error");
        return;
      }

      const descRaw = await ctx.ui.input(
        `Describe task ${id}`,
        "What is this task for? What needs to change?",
      );
      if (descRaw === undefined) { ctx.ui.notify("task_init cancelled", "info"); return; }
      const description = descRaw.trim(); // empty is allowed; task explained in chat

      const name = ctx.cwd.split("/").pop() || ctx.cwd;
      const m: Manifest = {
        id, type, phase: "analysis", primary: name,
        ...(description ? { description } : {}),
        repos: { [name]: { path: ctx.cwd, role: "primary" } },
        specPath: `docs/specs/${id}.md`,
        approvedSpecHash: null, snapshotHash: null,
        createdAt: new Date().toISOString(),
      };
      await saveManifest(id, m);
      await ctx.waitForIdle();
      pi.sendUserMessage(
        `skill://cracker\n\nTask **${id}** (type: ${type}). Primary: **${name}**.` +
        (description
          ? `\n\nDescription: ${description}`
          : `\n\nThe task description was intentionally left empty. Do NOT begin researching yet: ask the user in chat what they want, then analyze and write the spec.`) +
        `\n\nAnalyze this and write a spec to **docs/specs/${id}.md**. Use /task_add_repo ${id} <path> [target|reference] to attach additional repos before approving.`,
        { deliverAs: "steer", triggerTurn: true },
      );
    },
  });

  pi.registerCommand("task_add_repo", {
    description: "/task_add_repo <id> <path> [target|reference]",
    async handler(args, ctx) {
      const t = args.trim().split(/\s+/); const id = t[0];
      const raw = t.slice(1, -1).join(" "); const last = t[t.length - 1];
      const path = ROLES.includes(last) ? raw : args.trim().split(/\s+/).slice(1).join(" ");
      const role = ROLES.includes(last) ? last : "target";
      if (!id || !path || !validId(id)) { ctx.ui.notify("bad args", "error"); return; }
      const resolved = path.startsWith("~") ? path.replace("~", Bun.env.HOME || "/") : path;
      const name = resolved.split("/").pop() || resolved;
      const m = await loadManifest(id);
      if (!m) { ctx.ui.notify("not found", "error"); return; }
      if (m.phase !== "analysis") { ctx.ui.notify("analysis phase only", "error"); return; }
      if (m.repos[name]) { ctx.ui.notify(name + " already registered", "info"); return; }
      const gc = await pi.exec("git", ["-C", resolved, "rev-parse", "--show-toplevel"]);
      if (gc.code !== 0) { ctx.ui.notify("not a git repo: " + resolved, "error"); return; }
      m.repos[name] = { path: resolved, role };
      await saveManifest(id, m);
      ctx.ui.notify("added " + name + " (" + role + ")", "info");
    },
  });

  pi.registerCommand("task_approve", {
    description: "/task_approve <id> — approve spec, freeze hash",
    async handler(args, ctx) {
      const id = args.trim().split(/\s+/)[0];
      if (!id || !validId(id)) { ctx.ui.notify("bad id", "error"); return; }
      const m = await loadManifest(id);
      if (!m) { ctx.ui.notify("not found", "error"); return; }
      const p = m.repos[m.primary];
      if (!p) { ctx.ui.notify("primary not found", "error"); return; }
      const sa = p.path + "/" + m.specPath;
      try { await Bun.file(sa).text(); } catch { ctx.ui.notify("spec not found", "error"); return; }
      m.approvedSpecHash = await specHash(sa);
      m.phase = "approved";
      await saveManifest(id, m);
      ctx.ui.notify("approved. sha256:" + m.approvedSpecHash.slice(0, 12) + "...", "info");
    },
  });

  pi.registerCommand("task_handoff", {
    description: "/task_handoff <id> — create worktrees, start implementer in this session",
    async handler(args, ctx) {
      const id = args.trim().split(/\s+/)[0];
      if (!id || !validId(id)) { ctx.ui.notify("bad id", "error"); return; }
      const m = await loadManifest(id);
      if (!m) { ctx.ui.notify("not found", "error"); return; }
      if (m.phase !== "approved" && m.phase !== "ready") { ctx.ui.notify("not approved", "error"); return; }

      const pr = m.repos[m.primary];
      if (!pr) { ctx.ui.notify("primary not found", "error"); return; }
      const sa = pr.path + "/" + m.specPath;

      if (await specHash(sa) !== m.approvedSpecHash) { ctx.ui.notify("spec changed — re-approve", "error"); return; }

      const td = TASK_ROOT + "/" + id;
      const br = m.type + "/" + id;
      const todo: { name: string; repo: RepoEntry; baseSha: string }[] = [];

      for (const [name, repo] of Object.entries(m.repos)) {
        if (repo.role === "reference") continue;
        if (repo.worktreeCreated) {
          if (!repo.worktreePath || !repo.baseSha) { ctx.ui.notify("bad state: " + name, "error"); return; }
          if ((await pi.exec("test", ["-d", repo.worktreePath], { cwd: "/" })).code !== 0) { ctx.ui.notify("wt gone: " + name, "error"); return; }
          const wh = await pi.exec("git", ["-C", repo.worktreePath, "rev-parse", "HEAD"]);
          if (wh.code !== 0 || wh.stdout.trim() !== repo.baseSha) { ctx.ui.notify("sha mismatch: " + name, "error"); return; }
          continue;
        }
        const rc = await repoClean(pi, repo.path, repo.role === "primary" ? m.specPath : "__none__");
        if (!rc.clean) { ctx.ui.notify("dirty: " + name, "error"); return; }
        const so = await pi.exec("git", ["-C", repo.path, "rev-parse", "HEAD"]);
        if (so.code !== 0) { ctx.ui.notify("git err: " + name, "error"); return; }
        todo.push({ name, baseSha: so.stdout.trim(), repo });
      }

      for (const { name, repo, baseSha } of todo) {
        const wp = td + "/" + name;
        if ((await pi.exec("git", ["-C", repo.path, "worktree", "add", "-b", br, wp, baseSha])).code !== 0) {
          ctx.ui.notify("worktree fail: " + name, "error"); return;
        }
        repo.worktreeCreated = true;
        repo.branch = br;
        repo.baseSha = baseSha;
        repo.worktreePath = wp;
        await saveManifest(id, m);
      }

      const st = await Bun.file(sa).text();
      const snap = td + "/snapshot.spec.md";
      await Bun.write(snap, st);
      m.snapshotHash = (await pi.exec("shasum", ["-a", "256", snap])).stdout.trim().split(/\s+/)[0] || "";

      const pw = m.repos[m.primary];
      if (pw && pw.worktreePath) {
        const destDir = pw.worktreePath + "/" + m.specPath.split("/").slice(0, -1).join("/");
        try { await mkdir(destDir, { recursive: true }); } catch {}
        await Bun.write(pw.worktreePath + "/" + m.specPath, st);
      }

      m.phase = "ready";
      await saveManifest(id, m);

      // Handoff = transition THIS session into the implementer:
      //   1) move session cwd to the primary worktree (same as /move),
      //   2) attach target worktrees,
      //   3) inject the implementer prompt — skill:// loads the skill,
      //      triggerTurn starts the turn. Same process, same session,
      //      visible first-person. No new sessions, no new processes.
      const prompt = "skill://implementer\n\nSpec: " + snap +
        "\nPrimary worktree: " + (pw?.worktreePath ?? "?") +
        "\nImplement per the implementer skill: read the spec, confirm, implement, verify.";

      let moved = false;
      try {
        const sm = ctx.sessionManager as unknown as {
          moveTo(cwd: string): Promise<void>;
          addWorkspaceDirectory(dir: string): Promise<unknown>;
        };
        if (pw?.worktreePath) {
          await sm.moveTo(pw.worktreePath);   // session cwd → primary worktree
          moved = true;
        }
        for (const [n, r] of Object.entries(m.repos)) {
          if (r.role !== "reference" && r.worktreePath && n !== m.primary) {
            try { await sm.addWorkspaceDirectory(r.worktreePath); } catch {}
          }
        }
      } catch (e) {
        ctx.ui.notify("handoff moveTo failed: " + String(e), "warning");
      }

      if (moved) {
        await ctx.waitForIdle();
        // triggerTurn is runtime-supported (same pattern as /task_init) but
        // omitted from the SendUserMessageHandler d.ts — typed const keeps
        // tsc clean (excess-property checks apply to fresh literals only).
        const handoffOptions = {
          deliverAs: "steer",
          triggerTurn: true,
        } as { deliverAs: "steer"; triggerTurn: boolean };
        pi.sendUserMessage(prompt, handoffOptions);
        ctx.ui.notify(
          "implementer started in this session (worktree: " + (pw?.worktreePath ?? "?") + ")",
          "info",
        );
      } else {
        // Fallback: manual launch command (previous behavior).
        const cmd = ["omp --cwd " + td + "/" + m.primary];
        for (const [n, r] of Object.entries(m.repos)) {
          if (r.worktreePath && n !== m.primary) cmd.push("    --add-dir " + r.worktreePath);
        }
        cmd.push('    "/skill:implementer ' + snap + '"');
        await ctx.waitForIdle();
        pi.sendUserMessage(
          "Handoff complete. Worktrees: **" + td + "**\n\n```\n" + cmd.join(" \\\n") + "\n```",
          { deliverAs: "steer" },
        );
      }
    },
  });
}
