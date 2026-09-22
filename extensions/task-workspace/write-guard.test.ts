import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { guardManagedWriteTarget } from "./guard";
import { createGuardFixture, type GuardFixture } from "./shim/fixture";

let fx: GuardFixture;

beforeAll(async () => {
  fx = await createGuardFixture("agent-kit-write-guard-");
  // Fixture builds managed worktrees plus a burst of git spawns; on a
  // loaded machine that exceeds bun's default 5s hook timeout.
}, 60_000);

afterAll(async () => {
  if (fx) await fx.destroy();
});

describe("host-independent managed write guard", () => {
  test("classifies primary, temporary, metadata, and managed targets", () => {
    const primaryVerdict = guardManagedWriteTarget(
      join(fx.primary, "README.md"),
      fx.primary,
      { taskRoot: fx.taskRoot },
    );
    expect(primaryVerdict?.block).toBe(true);
    expect(primaryVerdict?.reason).toContain(fx.managed);

    expect(
      guardManagedWriteTarget("/tmp/agent-kit-write-guard-file", fx.primary, {
        taskRoot: fx.taskRoot,
      }),
    ).toBeUndefined();

    const metadataVerdict = guardManagedWriteTarget(
      join(fx.primary, ".git", "config"),
      fx.primary,
      { taskRoot: fx.taskRoot },
    );
    expect(metadataVerdict?.block).toBe(true);
    expect(metadataVerdict?.reason).toContain("Git metadata");

    expect(
      guardManagedWriteTarget(join(fx.managed, "README.md"), fx.managed, {
        taskRoot: fx.taskRoot,
      }),
    ).toBeUndefined();
  });
});
