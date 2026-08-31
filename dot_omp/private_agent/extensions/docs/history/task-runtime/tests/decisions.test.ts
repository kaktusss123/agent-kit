/**
 * §34.3 Decisions tests.
 *
 * Covers:
 *  - open decision reconstructed correctly from JSONL
 *  - resolve removes from open set
 *  - resolving unknown id fails
 *  - duplicate open id fails
 *  - malformed log line fails replay
 *  - open→resolve produces exactly 2 lines on disk (appendFile correctness)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let homeDir: string;
let originalBunHome: string | undefined;
let originalProcHome: string | undefined;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "tr-decisions-"));
  originalBunHome = Bun.env.HOME;
  originalProcHome = process.env.HOME;
  Bun.env.HOME = homeDir;
  process.env.HOME = homeDir;
});

afterEach(async () => {
  if (originalBunHome === undefined) delete Bun.env.HOME;
  else Bun.env.HOME = originalBunHome;
  if (originalProcHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalProcHome;
  await rm(homeDir, { recursive: true, force: true });
});

async function ensureTaskArtifacts(taskId: string): Promise<void> {
  const paths = await import("../paths.ts");
  await mkdir(paths.artifactsDir(taskId), { recursive: true });
}

describe("decision log round-trip", () => {
  test("open + replay → in open set", async () => {
    const dec = await import("../decisions.ts");
    await ensureTaskArtifacts("rid1");
    await dec.appendOpen("rid1", {
      id: "D-001",
      question: "Which generator?",
      dependsOn: [],
      options: ["a", "b"],
    });
    const open = await dec.getOpenDecisions("rid1");
    expect(open.length).toBe(1);
    expect(open[0].id).toBe("D-001");
    expect(open[0].options).toEqual(["a", "b"]);
  });

  test("open→resolve produces exactly 2 lines (appendFile correctness)", async () => {
    const dec = await import("../decisions.ts");
    const paths = await import("../paths.ts");
    await ensureTaskArtifacts("rid2");
    await dec.appendOpen("rid2", {
      id: "D-002",
      question: "Q?",
      dependsOn: [],
      options: ["x", "y"],
    });
    await dec.appendResolve("rid2", { id: "D-002", answer: "x", source: "user" });
    const content = await readFile(paths.decisionsPath("rid2"), "utf8");
    const lines = content.split("\n").filter(l => l.trim() !== "");
    expect(lines.length).toBe(2);
    const r0 = JSON.parse(lines[0]);
    const r1 = JSON.parse(lines[1]);
    expect(r0.op).toBe("open");
    expect(r1.op).toBe("resolve");
    expect(r1.answer).toBe("x");
  });

  test("open then resolve → resolved set contains the answer", async () => {
    const dec = await import("../decisions.ts");
    await ensureTaskArtifacts("rid3");
    await dec.appendOpen("rid3", {
      id: "D-003",
      question: "Q?",
      dependsOn: [],
      options: ["x"],
    });
    await dec.appendResolve("rid3", { id: "D-003", answer: "x", source: "user" });
    const open = await dec.getOpenDecisions("rid3");
    const resolved = await dec.getResolvedDecisions("rid3");
    expect(open.length).toBe(0);
    expect(resolved.length).toBe(1);
    expect(resolved[0].answer).toBe("x");
  });
});

describe("decision log rejects malformed state", () => {
  test("opening the same id twice fails", async () => {
    const dec = await import("../decisions.ts");
    await ensureTaskArtifacts("rid4");
    await dec.appendOpen("rid4", {
      id: "D-DUP",
      question: "Q?",
      dependsOn: [],
      options: ["a"],
    });
    await expect(
      dec.appendOpen("rid4", {
        id: "D-DUP",
        question: "Q?",
        dependsOn: [],
        options: ["a"],
      }),
    ).rejects.toThrow(/already open/);
  });

  test("resolving an unknown id fails", async () => {
    const dec = await import("../decisions.ts");
    await ensureTaskArtifacts("rid5");
    await expect(
      dec.appendResolve("rid5", { id: "D-NONE", answer: "x", source: "user" }),
    ).rejects.toThrow(/not open/);
  });

  test("resolving the same id twice fails on the second call", async () => {
    const dec = await import("../decisions.ts");
    await ensureTaskArtifacts("rid6");
    await dec.appendOpen("rid6", {
      id: "D-RT",
      question: "Q?",
      dependsOn: [],
      options: ["a"],
    });
    await dec.appendResolve("rid6", { id: "D-RT", answer: "a", source: "user" });
    await expect(
      dec.appendResolve("rid6", { id: "D-RT", answer: "a", source: "user" }),
    ).rejects.toThrow(/not open/);
  });

  test("malformed JSONL line is detected on read", async () => {
    const dec = await import("../decisions.ts");
    const paths = await import("../paths.ts");
    const { appendFile } = await import("node:fs/promises");
    await ensureTaskArtifacts("rid7");
    await dec.appendOpen("rid7", {
      id: "D-OK",
      question: "Q?",
      dependsOn: [],
      options: ["a"],
    });
    await appendFile(paths.decisionsPath("rid7"), "{ not json\n");
    await expect(dec.getOpenDecisions("rid7")).rejects.toThrow(/malformed/);
  });

  test("resolve rejects missing answer at append time (spec §15.3)", async () => {
    const dec = await import("../decisions.ts");
    await ensureTaskArtifacts("rid9");
    await dec.appendOpen("rid9", {
      id: "D-N",
      question: "Q?",
      dependsOn: [],
      options: ["a"],
    });
    await expect(
      // @ts-expect-error intentionally missing answer
      dec.appendResolve("rid9", { id: "D-N", source: "user" }),
    ).rejects.toThrow(/non-empty answer/);
  });

  test("resolve rejects empty answer at append time", async () => {
    const dec = await import("../decisions.ts");
    await ensureTaskArtifacts("rid9b");
    await dec.appendOpen("rid9b", {
      id: "D-NE",
      question: "Q?",
      dependsOn: [],
      options: ["a"],
    });
    await expect(
      dec.appendResolve("rid9b", { id: "D-NE", answer: "", source: "user" }),
    ).rejects.toThrow(/non-empty answer/);
  });

  test("resolve rejects invalid source value", async () => {
    const dec = await import("../decisions.ts");
    await ensureTaskArtifacts("rid9c");
    await dec.appendOpen("rid9c", {
      id: "D-NS",
      question: "Q?",
      dependsOn: [],
      options: ["a"],
    });
    await expect(
      // @ts-expect-error intentionally wrong source
      dec.appendResolve("rid9c", { id: "D-NS", answer: "a", source: "ai" }),
    ).rejects.toThrow();
  });
});
