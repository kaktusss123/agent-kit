import { FsArtifactStore } from "./adapters/fs-artifact-store.ts";
import { FsContractImporter } from "./adapters/fs-contract-importer.ts";
import { createGitWorkspace } from "./adapters/git-workspace.ts";
import { OmpRpcAgentRuntime } from "./adapters/omp/rpc-runtime.ts";
import { OmpReviewer } from "./adapters/omp/reviewer.ts";
import { OmpCandidateRuntime } from "./adapters/omp/candidate-runtime.ts";
import { LocalProcessHost } from "./adapters/local-process-host.ts";
import { LocalRunDriverHost } from "./adapters/local-run-driver-host.ts";
import { ShellVerificationRunner } from "./adapters/shell-verification.ts";
import { TcsfFactory } from "./app/factory.ts";
import type { DecisionRequest, DecisionResolution } from "./core/types.ts";
import type { FailpointPort } from "./ports/failpoint.ts";
import type { HumanDecisionPort } from "./ports/human-decision.ts";
import type { VerificationRunner } from "./ports/verification.ts";
import type { AgentRuntime } from "./ports/agent-runtime.ts";
import type { ReviewPort } from "./ports/review.ts";
class OmpHumanDecisions implements HumanDecisionPort {
  private readonly resolutions = new Map<string, DecisionResolution>();
  constructor(private readonly notify: (message: string) => void = message => process.stderr.write(`${message}\n`)) {}
  async publish(request: DecisionRequest): Promise<void> { this.notify(`[tcsf] decision required (${request.category}): ${request.question} [${request.id}]`); }
  async readResolution(decisionId: string): Promise<DecisionResolution | null> { return this.resolutions.get(decisionId) ?? null; }
}
export interface DefaultFactoryOptions { driverProcessPath?: string; verification?: VerificationRunner; failpoint?: FailpointPort; agentRuntime?: AgentRuntime; reviewer?: ReviewPort; }
export function createDefaultFactory(root: string, notify?: (message: string) => void, controllerId = process.env.TCSF_CONTROLLER_ID ?? `controller:${process.pid}`, leaseToken?: string, options: DefaultFactoryOptions = {}): TcsfFactory {
  const artifacts = new FsArtifactStore(root); const decisions = new OmpHumanDecisions(notify);
  const runtime = options.agentRuntime ?? new OmpRpcAgentRuntime();
  const reviewer = options.reviewer ?? new OmpReviewer(runtime, `${root}/sessions`);
  const factory = new TcsfFactory({ artifacts, decisions, contractImporter: new FsContractImporter(), controllerId, leaseToken, agentRuntime: runtime, reviewer, candidateRuntime: new OmpCandidateRuntime(), executionHost: new LocalProcessHost(`${root}/hosts`), runDriverHost: new LocalRunDriverHost(root, options.driverProcessPath), workspace: createGitWorkspace(), verification: options.verification ?? new ShellVerificationRunner(), failpoint: options.failpoint });
  return factory;
}
