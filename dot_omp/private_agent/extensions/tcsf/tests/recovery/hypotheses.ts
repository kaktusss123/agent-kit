import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HYPOTHESES, assertCompleteHypotheses, type HypothesisEvidence } from "../../probes/hypotheses.ts";

const root = process.env.TCSF_ACCEPTANCE_ROOT ?? join(process.env.HOME ?? ".", ".omp", "tcsf-acceptance-20260830");
const outputRoot = join(root, "hypotheses", new Date().toISOString().replace(/[:.]/gu, "-"));
await mkdir(outputRoot, { recursive: true });
const results: HypothesisEvidence[] = [];
for (const card of HYPOTHESES) {
  const directory = join(outputRoot, card.id); await mkdir(directory, { recursive: true });
  const experiment = Bun.spawn(card.experiment.command, { cwd: join(import.meta.dir, "..", ".."), env: { ...process.env, TCSF_ACCEPTANCE_ROOT: join(directory, "acceptance") }, stdout: "pipe", stderr: "pipe", detached: true });
  const [stdout, stderr] = await Promise.all([new Response(experiment.stdout).text(), new Response(experiment.stderr).text()]);
  const exitCode = await experiment.exited;
  await writeFile(join(directory, "stdout.log"), stdout); await writeFile(join(directory, "stderr.log"), stderr);
  const evidencePaths = [`hypotheses/${outputRoot.split("/hypotheses/").pop()}/${card.id}/stdout.log`, `hypotheses/${outputRoot.split("/hypotheses/").pop()}/${card.id}/stderr.log`];
  const verdict = exitCode === 0 ? "CONFIRMED" : "BLOCKED";
  results.push({ id: card.id, title: card.title, definitionHash: card.definitionHash, verdict, observed: `Executable experiment ${card.experiment.command.join(" ")} exited with code ${exitCode}.`, evidencePaths, selectedFallback: verdict === "REJECTED_WITH_FALLBACK" ? card.fallback : null, fallbackEvidencePaths: [], downstream: "No downstream claim is promoted without this durable result.", dependsOn: [] });
  await writeFile(join(directory, "result.json"), `${JSON.stringify(results.at(-1), null, 2)}\n`);
}
assertCompleteHypotheses(results);
await writeFile(join(outputRoot, "registry-run.json"), `${JSON.stringify({ outputRoot, results, completedAt: new Date().toISOString() }, null, 2)}\n`);
console.log(JSON.stringify({ outputRoot, results }, null, 2));
