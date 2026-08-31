import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertCompleteHypotheses, hypothesisById, validateHypothesisEvidence, type HypothesisEvidence } from "./hypotheses.ts";

export interface ProbeResult extends HypothesisEvidence {
  readonly commands: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly priorEvidence: string;
}

export async function writeProbeResult(root: string, result: ProbeResult): Promise<string> {
  const card = hypothesisById(result.id);
  if (result.title !== card.title || result.definitionHash !== card.definitionHash) throw new Error(`${result.id} does not match the canonical hypothesis definition`);
  validateHypothesisEvidence(result);
  const destination = join(root, "reports", "hypotheses", `${result.id}.json`);
  const temporary = `${destination}.${process.pid}.tmp`;
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
  return destination;
}

export function validateProbeResults(results: readonly ProbeResult[]): void {
  assertCompleteHypotheses(results);
}
