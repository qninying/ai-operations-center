// Shared types for the SSRS read path, mirroring dmvTypes.ts exactly — ssrsReader.ts
// (orchestration) and ssrsLiveSource.ts (real I/O) both depend on these without
// depending on each other.

export const SUPPORTED_SSRS_QUERIES = ["ExecutionLog3"] as const;
export type SupportedSsrsQuery = (typeof SUPPORTED_SSRS_QUERIES)[number];

export interface ReadSsrsInput {
  queryName: string;
  reportPath?: string;
}
