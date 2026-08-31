import { describe, expect, test } from "bun:test";
import { HYPOTHESES, assertCompleteHypotheses, type HypothesisEvidence } from "../probes/hypotheses.ts";

function evidence(verdict: HypothesisEvidence["verdict"] = "CONFIRMED"): HypothesisEvidence[] {
  return HYPOTHESES.map(card => ({ id: card.id, title: card.title, definitionHash: card.definitionHash, verdict, observed: "durable observation", evidencePaths: [`reports/hypotheses/${card.id}.json`], selectedFallback: verdict === "REJECTED_WITH_FALLBACK" ? card.fallback : null, fallbackEvidencePaths: verdict === "REJECTED_WITH_FALLBACK" ? [`reports/hypotheses/${card.id}-fallback.json`] : [], downstream: "none", dependsOn: [] }));
}

describe("canonical hypothesis catalog", () => {
  test("accepts all canonical entries with durable evidence", () => { expect(() => assertCompleteHypotheses(evidence())).not.toThrow(); });
  test("rejects alternate titles and definition hashes", () => {
    const wrongTitle = evidence(); wrongTitle[0] = { ...wrongTitle[0], title: "alternate" }; expect(() => assertCompleteHypotheses(wrongTitle)).toThrow("canonical title");
    const wrongHash = evidence(); wrongHash[0] = { ...wrongHash[0], definitionHash: "wrong" }; expect(() => assertCompleteHypotheses(wrongHash)).toThrow("definition hash");
  });
  test("rejects missing evidence and incomplete catalog", () => {
    const noEvidence = evidence(); noEvidence[0] = { ...noEvidence[0], observed: "", evidencePaths: [] }; expect(() => assertCompleteHypotheses(noEvidence)).toThrow("no durable evidence");
    expect(() => assertCompleteHypotheses(evidence().slice(0, -1))).toThrow("incomplete");
  });
  test("requires a successful fallback for rejected hypotheses", () => { const rejected = evidence("REJECTED_WITH_FALLBACK"); rejected[0] = { ...rejected[0], fallbackEvidencePaths: [] }; expect(() => assertCompleteHypotheses(rejected)).toThrow("fallback evidence"); });
  test("rejects downstream dependencies on blocked capabilities", () => { const blocked = evidence(); blocked[1] = { ...blocked[1], verdict: "BLOCKED" }; blocked[0] = { ...blocked[0], dependsOn: ["H-02"] }; expect(() => assertCompleteHypotheses(blocked)).toThrow("non-confirmed hypothesis"); });
});
