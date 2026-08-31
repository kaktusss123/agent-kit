import type { ApprovedContractPacket } from "../core/types.ts";

export type ContractArtifactKey = "spec" | "evidence" | "decisions" | "verification";

export interface FrozenContractArtifact {
  readonly key: ContractArtifactKey;
  readonly sourcePath: string;
  readonly copiedPath: string;
  readonly size: number;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface FrozenContractImport {
  readonly importedAt: string;
  readonly artifacts: readonly FrozenContractArtifact[];
  readonly snapshotSha256: string;
}

export interface ContractImporter {
  import(packet: ApprovedContractPacket, sourceRoot?: string): Promise<FrozenContractImport>;
}
