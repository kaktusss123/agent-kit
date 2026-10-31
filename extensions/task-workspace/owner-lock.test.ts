/**
 * Cross-process ownership of one managed worktree.
 *
 * The contract is explicitly inter-process: one live RepoOwner per worktree
 * per host, regardless of how many Pi processes ask. Half of these tests
 * therefore drive real OS processes (the fixture in ./fixtures) instead of
 * second objects in the test process:
 *
 * - two racing owners: exactly one acquires, the other is refused with the
 *   holder's identity;
 * - a crashed parent with a still-live child: the worktree stays locked until
 *   the child is provably gone, then it is recoverable;
 * - repeated acquire/release cycles and independent worktrees (the lease is
 *   per worktree, not one mutex for the host).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after as afterAll, describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import {
  acquireOwnerLease,
  describeOwner,
  describeOwnerRefusal,
  ownerRecordPath,
  recordOwnerChild,
  releaseOwnerLease,
  type OwnerRecord,
  type OwnerView,
} from "./owner-lock.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "owner-lock-process.ts");

let rootDir: string | null = null;
const running = new Set<ChildProcess>();

function tempRoot(prefix: string): { taskRoot: string; workspace: string } {
  rootDir ??= mkdtempSync(join(tmpdir(), "owner-lock-"));
  const base = join(rootDir, `${prefix}-${Math.random().toString(36).slice(2, 8)}`);
  const taskRoot = join(base, "tasks");
  const workspace = join(taskRoot, "feat%2Ftask", "repo");
  mkdirSync(workspace, { recursive: true });
  return { taskRoot, workspace };
}

afterAll(() => {
  for (const proc of running) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
});

interface Fixture {
  proc: ChildProcess;
  nextLine(): Promise<Record<string, unknown>>;
  exited: Promise<number | null>;
}

/** Spawn the fixture as a real second (third, ...) OS process. */
function startFixture(mode: string, taskRoot: string, workspace: string, extra?: string): Fixture {
  const proc = spawn(process.execPath, [FIXTURE, mode, taskRoot, workspace, ...(extra ? [extra] : [])], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  running.add(proc);
  let buffer = "";
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  proc.stdout!.setEncoding("utf8");
  proc.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
      index = buffer.indexOf("\n");
    }
  });
  const exited = new Promise<number | null>((resolve) => proc.on("exit", (code) => resolve(code)));
  return {
    proc,
    exited,
    nextLine() {
      const line = lines.shift();
      if (line !== undefined) return Promise.resolve(JSON.parse(line) as Record<string, unknown>);
      return new Promise((resolve) => {
        waiters.push((next) => resolve(JSON.parse(next) as Record<string, unknown>));
      });
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition was not reached in time");
}

function writeRawRecord(taskRoot: string, workspace: string, record: Partial<OwnerRecord>): void {
  const recordPath = ownerRecordPath(taskRoot, workspace);
  mkdirSync(join(taskRoot, ".owners"), { recursive: true });
  writeFileSync(recordPath, JSON.stringify(record));
}

describe("worktree ownership lease", () => {
  test("acquire → release → acquire, repeatedly", async () => {
    const { taskRoot, workspace } = tempRoot("cycle");
    for (let i = 0; i < 3; i++) {
      const acquired = await acquireOwnerLease(taskRoot, workspace);
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;
      const view = describeOwner(taskRoot, workspace);
      expect(view.state).toBe("owned");
      expect(view.holder?.processes.map((p) => p.role)).toEqual(["parent"]);
      expect(view.holder?.processes[0]?.pid).toBe(process.pid);
      expect(releaseOwnerLease(acquired.lease)).toBe(true);
      expect(describeOwner(taskRoot, workspace).state).toBe("free");
    }
  });

  test("a second owner in the same process is refused with the holder facts", async () => {
    const { taskRoot, workspace } = tempRoot("second");
    const first = await acquireOwnerLease(taskRoot, workspace);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    try {
      const second = await acquireOwnerLease(taskRoot, workspace);
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.reason).toBe("owned");
      expect(second.view.state).toBe("owned");
      expect(second.view.holder?.processes[0]?.pid).toBe(process.pid);
      const text = describeOwnerRefusal(second.view);
      expect(text).toContain(workspace);
      expect(text).toContain(`pid ${process.pid}`);
      // The refusal says how to inspect the state, and that a retry waits.
      expect(text).toContain("task_status");
      expect(text).toContain("child process exits");
    } finally {
      releaseOwnerLease(first.lease);
    }
  });

  test("the lease is per worktree, not one mutex for the host", async () => {
    const a = tempRoot("parallel-a");
    const b = tempRoot("parallel-b");
    const first = await acquireOwnerLease(a.taskRoot, a.workspace);
    const second = await acquireOwnerLease(b.taskRoot, b.workspace);
    // Same task root as well: two worktrees of one task never block each other.
    const c = join(a.taskRoot, "feat%2Ftask", "repo__lane");
    mkdirSync(c, { recursive: true });
    const third = await acquireOwnerLease(a.taskRoot, c);
    expect(first.ok && second.ok && third.ok).toBe(true);
    if (first.ok) releaseOwnerLease(first.lease);
    if (second.ok) releaseOwnerLease(second.lease);
    if (third.ok) releaseOwnerLease(third.lease);
  });

  test("the child is part of the record once dispatched", async () => {
    const { taskRoot, workspace } = tempRoot("child");
    const acquired = await acquireOwnerLease(taskRoot, workspace);
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    try {
      expect(recordOwnerChild(acquired.lease, process.ppid, { agentId: "run-1" })).toBe(true);
      const view = describeOwner(taskRoot, workspace);
      expect(view.state).toBe("owned");
      expect(view.holder?.agentId).toBe("run-1");
      expect(view.holder?.processes.map((p) => p.role)).toEqual(["parent", "child"]);
      // A pid that is not a pid is never recorded as the child.
      expect(recordOwnerChild(acquired.lease, 0)).toBe(false);
    } finally {
      releaseOwnerLease(acquired.lease);
    }
  });

  test("an unreadable record refuses instead of guessing", async () => {
    const { taskRoot, workspace } = tempRoot("corrupt");
    const recordPath = ownerRecordPath(taskRoot, workspace);
    mkdirSync(join(taskRoot, ".owners"), { recursive: true });
    writeFileSync(recordPath, "{not json");
    const view = describeOwner(taskRoot, workspace);
    expect(view.state).toBe("unknown");
    const acquired = await acquireOwnerLease(taskRoot, workspace);
    expect(acquired.ok).toBe(false);
    if (!acquired.ok) expect(acquired.reason).toBe("unverifiable");
    expect(existsSync(recordPath)).toBe(true);
  });

  test("a record from another host is refused, never stolen", async () => {
    const { taskRoot, workspace } = tempRoot("foreign");
    writeRawRecord(taskRoot, workspace, {
      version: 1,
      token: "foreign-token",
      workspace,
      host: "some-other-host",
      state: "owned",
      acquiredAt: Date.now(),
      updatedAt: Date.now(),
      parent: { pid: process.pid, start: "linux:1" },
    });
    const view = describeOwner(taskRoot, workspace);
    expect(view.state).toBe("foreign_host");
    const acquired = await acquireOwnerLease(taskRoot, workspace);
    expect(acquired.ok).toBe(false);
    if (!acquired.ok) expect(describeOwnerRefusal(acquired.view)).toContain("another host");
  });

  test("a crashed owner with a live child keeps the worktree locked (real processes)", async () => {
    const { taskRoot, workspace } = tempRoot("orphan");
    const childPidFile = join(taskRoot, "child.pid");
    const owner = startFixture("owner-with-child", taskRoot, workspace, childPidFile);
    const started = await owner.nextLine();
    expect(started.ok).toBe(true);
    const childPid = Number(started.childPid);
    expect(childPid).toBeGreaterThan(0);
    await waitFor(() => existsSync(childPidFile));

    // Simulate an ungraceful Main death: the lease record stays behind with a
    // live child process.
    owner.proc.kill("SIGKILL");
    await owner.exited;

    const view = describeOwner(taskRoot, workspace);
    expect(view.state).toBe("owned");
    expect(view.holder?.processes.find((p) => p.role === "child")?.alive).toBe(true);

    // Same host, another OS process: refused with the live child's identity.
    const attempt = startFixture("attempt", taskRoot, workspace);
    const attemptResult = await attempt.nextLine();
    expect(attemptResult.ok).toBe(false);
    expect(JSON.stringify(attemptResult)).toContain(String(childPid));
    await attempt.exited;

    // The in-process retry is refused as well.
    const inProcess = await acquireOwnerLease(taskRoot, workspace);
    expect(inProcess.ok).toBe(false);

    // Only after the child is provably gone does the worktree become free.
    process.kill(childPid, "SIGKILL");
    await waitFor(() => describeOwner(taskRoot, workspace).state === "stale");
    const recovered = await acquireOwnerLease(taskRoot, workspace);
    expect(recovered.ok).toBe(true);
    if (recovered.ok) releaseOwnerLease(recovered.lease);
  });

  test("two racing owner processes produce exactly one owner", async () => {
    const { taskRoot, workspace } = tempRoot("race");
    const a = startFixture("hold", taskRoot, workspace);
    const b = startFixture("hold", taskRoot, workspace);
    const [first, second] = await Promise.all([a.nextLine(), b.nextLine()]);
    const winners = [first, second].filter((r) => r.ok === true);
    const losers = [first, second].filter((r) => r.ok === false);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    // The loser learns who holds the worktree.
    const winnerPid = first.ok === true ? a.proc.pid : b.proc.pid;
    expect(JSON.stringify(losers[0])).toContain(String(winnerPid));
    a.proc.kill("SIGKILL");
    b.proc.kill("SIGKILL");
    await Promise.all([a.exited, b.exited]);
  });

  test("repeated acquire/release cycles across processes all succeed", async () => {
    const { taskRoot, workspace } = tempRoot("cross-cycle");
    for (let i = 0; i < 3; i++) {
      const attempt = startFixture("attempt", taskRoot, workspace);
      const result = await attempt.nextLine();
      expect(result.ok).toBe(true);
      expect(await attempt.exited).toBe(0);
      expect(describeOwner(taskRoot, workspace).state).toBe("free");
    }
  });

  test("a stale record is recovered by exactly one of two racing processes", async () => {
    const { taskRoot, workspace } = tempRoot("stale-race");
    // A dead owner: an exited short-lived process.
    const dead = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise((resolve) => dead.on("exit", resolve));
    writeRawRecord(taskRoot, workspace, {
      version: 1,
      token: "dead-token",
      workspace,
      host: hostname(),
      state: "owned",
      acquiredAt: Date.now(),
      updatedAt: Date.now(),
      parent: { pid: dead.pid, start: "linux:999999" },
    });
    let view: OwnerView = describeOwner(taskRoot, workspace);
    await waitFor(() => describeOwner(taskRoot, workspace).state === "stale");
    view = describeOwner(taskRoot, workspace);
    expect(view.state).toBe("stale");

    const a = startFixture("hold", taskRoot, workspace);
    const b = startFixture("hold", taskRoot, workspace);
    const [first, second] = await Promise.all([a.nextLine(), b.nextLine()]);
    expect([first, second].filter((r) => r.ok === true)).toHaveLength(1);
    a.proc.kill("SIGKILL");
    b.proc.kill("SIGKILL");
    await Promise.all([a.exited, b.exited]);
  });
});
