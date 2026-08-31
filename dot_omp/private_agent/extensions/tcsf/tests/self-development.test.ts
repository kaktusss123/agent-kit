import { describe, expect, test } from "bun:test";
import { isSelfChange } from "../app/self-development.ts";

const repository = (canonicalPath: string, writableScope?: string[]) => ({ role: "primary" as const, repoKey: "repo", canonicalPath, baseSha: "base", writableScope });

describe("self-change detection", () => {
  test("recognizes the dotfiles TCSF writable scope", () => {
    expect(isSelfChange([repository("/Users/test/projects/dotfiles", ["dot_omp/private_agent/extensions/tcsf/**"])] )).toBe(true);
    expect(isSelfChange([repository("/Users/test/projects/dotfiles", ["dot_omp/private_agent/skills/implementer/SKILL.md"])] )).toBe(true);
  });
  test("does not classify unrelated repositories or scopes", () => {
    expect(isSelfChange([repository("/Users/test/projects/product", ["src/**"])] )).toBe(false);
    expect(isSelfChange([repository("/Users/test/projects/dotfiles", ["dot_omp/private_agent/extensions/other/**"])] )).toBe(false);
  });
});
