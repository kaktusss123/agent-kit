#!/usr/bin/env bun
/**
 * runtime-smoke — L4 lifecycle integration.
 * Creates a disposable repo, runs full cracker→approve→handoff→
 * implementer→submit cycle with real git. Exits 0 if all pass.
 */
import { join } from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import type { ExecFn } from "../extensions/task-runtime/types.ts";

const exec: ExecFn = (cmd, args, opts) => new Promise(r => execFile(cmd, args, {maxBuffer: 100*1024*1024, cwd: opts?.cwd}, (e, o, s) => {const code = e ? ((e as any).code??1):0; r({code,stdout:o.toString(),stderr:s.toString()})}));

async function main() {
  const homeDir = await mkdtemp(join(tmpdir(), "tr-")); Bun.env.HOME = homeDir; process.env.HOME = homeDir;
  try {
    const repoDir = join(homeDir, "repo"); await mkdir(repoDir, {recursive:true});
    const { loadManifest } = await import("../extensions/task-runtime/storage.ts");
    const { snapshotDir } = await import("../extensions/task-runtime/paths.ts");
    const { createTask, markReady, approveTask, prepareWorktrees, buildHandoff, startImplementation, submitImplementation } = await import("../extensions/task-runtime/lifecycle.ts");

    await exec("git",["-C",repoDir,"init"]); 
    await exec("git",["-C",repoDir,"config","user.email","t@t"]);
    await exec("git",["-C",repoDir,"config","user.name","t"]);
    writeFileSync(join(repoDir,"R.md"),"#T\n");
    await exec("git",["-C",repoDir,"add","."]);
    await exec("git",["-C",repoDir,"commit","-m","init"]);

    const id = "s"+Date.now().toString(36);
    const m = await createTask({id, type:"feat", primarySourcePath:repoDir, crackerSessionFile:"/cr", exec});
    console.log("1. create", m.phase, m.id);

    const ad = join(homeDir,".omp","tasks",id,"artifacts");
    await mkdir(ad,{recursive:true});
    writeFileSync(join(ad,"spec.md"),"spec");
    writeFileSync(join(ad,"evidence.md"),"evidence");
    writeFileSync(join(ad,"verification.json"), JSON.stringify({checks:[{id:"c1",repo:m.primaryRepo,command:"test -f GUIDE.md",required:true}]}));

    let mr = await markReady(id, exec);
    if (!mr.readiness.ok) throw new Error("not ready: " + JSON.stringify(mr.readiness.issues));
    console.log("2. ready", mr.manifest.phase);

    let ar = await approveTask({taskId:id, exec});
    console.log("3. approve", ar.manifest.phase, ar.approval.id.slice(0,20));

    let pw = await prepareWorktrees({taskId:id, exec});
    console.log("4. worktrees", pw.createdRepos);

    let ho = await buildHandoff({taskId:id, approvalId:ar.approval.id});
    console.log("5. handoff", ho.taskId);

    await startImplementation({taskId:id, approvalId:ar.approval.id, implementerSessionFile:"/is", exec});
    let m3 = loadManifest(id);
    console.log("6. implementing", m3.phase);

    const wt = m.repos[m.primaryRepo]?.worktreePath!;
    writeFileSync(join(wt,"GUIDE.md"),"# Guide\n");
    writeFileSync(join(repoDir,"human-tmp.txt"),"human\n"); // dirty source - no block

    let so = await submitImplementation({taskId:id, approvalId:ar.approval.id, exec});
    console.log("7. submit", so.kind);
    if (so.kind !== "completed") throw new Error("submit: " + so.kind + " " + (so as any).reason);

    const snap = JSON.parse(readFileSync(join(snapshotDir(id,ar.approval.id),"verification.json"),"utf-8"));
    if (snap.checks[0].command !== "test -f GUIDE.md") throw new Error("snapshot corrupted");
    console.log("8. snapshot intact");

    console.log("\nALL CHECKS PASSED");
  } finally {
    await rm(homeDir,{recursive:true,force:true});
  }
}
main().catch(e => { console.error("FATAL:",e.message||e); process.exit(1); });
