export interface CandidateInspectionInput {
  extensionPath: string;
  cwd: string;
  sessionDirectory: string;
  environment?: Record<string, string>;
}

export interface CandidateInspectionResult {
  passed: boolean;
  bundlePath: string;
  candidatePid?: number;
  commandNames: string[];
  toolNames: string[];
  duplicateCommands: string[];
  duplicateTools: string[];
  output: string;
  evidencePath?: string;
}

export interface CandidateScenarioInput extends CandidateInspectionInput {
  scenarioId: string;
  scenarioManifestPath: string;
  timeoutMs?: number;
  packRunId?: string;
  packSequence?: number;
  sourceSnapshotHash?: string;
}

export interface CandidatePackInput extends CandidateInspectionInput {
  scenarioRoot: string;
  timeoutMs?: number;
}

export interface CandidatePackResult {
  packRunId?: string;
  sourceSnapshotRoot?: string;
  sourceSnapshotHash?: string;
  scenarios: Array<{ id: string; sequence?: number; inspection?: CandidateInspectionResult; scenario?: CandidateScenarioResult }>;
  passed: boolean;
}

export interface CandidateScenarioResult {
  scenarioId: string;
  passed: boolean;
  candidatePid?: number;
  exitCode: number;
  eventPath?: string;
  artifactPaths: string[];
  output: string;
  cleanupSucceeded: boolean;
  terminalObserved: boolean;
}

export type CandidateRuntimeInput = CandidateInspectionInput;
export type CandidateRuntimeResult = CandidateInspectionResult;

export interface CandidateRuntimePort {
  inspectCandidate(input: CandidateInspectionInput): Promise<CandidateInspectionResult>;
  executeScenario(input: CandidateScenarioInput): Promise<CandidateScenarioResult>;
  executePack?(input: CandidatePackInput): Promise<CandidatePackResult>;
}
