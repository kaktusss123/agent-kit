/**
 * Test fixture: ONE OS process that exercises the worktree ownership lease
 * from outside the test runner.
 *
 * The ownership contract is cross-process by nature, so at least one test
 * must observe it from a second real process instead of a second object in
 * the same process. This script is that second (third, ...) process; it is a
 * fixture, not part of the extension surface.
 *
 * Usage: bun owner-lock-process.ts <mode> <taskRoot> <workspace> [extra]
 *   hold              acquire, print the result, keep the lease while stdin
 *                     stays open, then release and print the release result
 *   owner-with-child  acquire, spawn a long-lived "child", record it in the
 *                     lease, write its pid to <extra>, print the result, then
 *                     block until killed (the test SIGKILLs this process to
 *                     simulate a crashed Main with a live child)
 *   attempt           acquire once, print the result, release when acquired
 *   describe          print the observable owner view and exit
 */
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  acquireOwnerLease,
  describeOwner,
  recordOwnerChild,
  releaseOwnerLease,
} from "../owner-lock";

const [mode, taskRoot, workspace, extra] = process.argv.slice(2);

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function die(message: string): never {
  emit({ ok: false, reason: message });
  process.exit(2);
}

if (!mode || !taskRoot || !workspace) die("usage: <mode> <taskRoot> <workspace> [extra]");

if (mode === "describe") {
  emit(describeOwner(taskRoot, workspace));
} else if (mode === "attempt") {
  const result = await acquireOwnerLease(taskRoot, workspace);
  emit(result);
  if (result.ok) releaseOwnerLease(result.lease);
} else if (mode === "hold") {
  const result = await acquireOwnerLease(taskRoot, workspace);
  emit(result);
  if (!result.ok) process.exit(1);
  const lease = result.lease;
  // Hold until the supervisor closes stdin (or kills the process).
  process.stdin.resume();
  const finish = () => {
    emit({ released: releaseOwnerLease(lease) });
    process.exit(0);
  };
  process.stdin.on("end", finish);
  process.stdin.on("close", finish);
} else if (mode === "owner-with-child") {
  if (!extra) die("owner-with-child requires a child pid file path");
  const result = await acquireOwnerLease(taskRoot, workspace);
  if (!result.ok) {
    emit(result);
    process.exit(1);
  }
  const child: ChildProcess = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
  });
  const childPid = child.pid;
  if (!recordOwnerChild(result.lease, childPid, { agentId: "fixture-child" })) {
    emit({ ok: false, reason: "child could not be recorded in the lease" });
    process.exit(1);
  }
  writeFileSync(extra, String(childPid));
  emit({ ok: true, childPid, view: describeOwner(taskRoot, workspace) });
  // Stay alive until the supervisor SIGKILLs this process; the child outlives it.
  setInterval(() => {}, 60_000);
} else {
  die(`unknown mode: ${mode}`);
}
