// Shared types for the DMV read path. Extracted so dmvReader.ts (orchestration) and
// dmvLiveSource.ts (real I/O) can both depend on these without depending on each other.

export const SUPPORTED_DMVS = ["sys.dm_exec_requests"] as const;
export type SupportedDmv = (typeof SUPPORTED_DMVS)[number];

export interface ReadDmvInput {
  dmvName: string;
  databaseName?: string;
}
