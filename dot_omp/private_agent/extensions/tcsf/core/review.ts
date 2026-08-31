export interface ReviewFinding { file?: string; behavior: string; violatedContract: string; severity: "blocking" | "non_blocking"; expectedCorrection: string; }
export interface ReviewResult { verdict: "pass" | "fail" | "decision_required"; summary: string; findings: ReviewFinding[]; }
