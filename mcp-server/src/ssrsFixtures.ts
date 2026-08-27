export interface SsrsExecutionLogRow {
  instance_name: string;
  report_path: string;
  user_name: string;
  status: string;
  time_start: string;
  time_end: string | null;
  time_data_retrieval_ms: number;
  time_processing_ms: number;
  time_rendering_ms: number;
}

// STUB: fixture data standing in for a live SSRS ExecutionLog3 query. Swap for a
// real mssql query against the ReportServer catalog database when a target SSRS
// instance + read-only credentials are available. Status values are real SSRS
// execution-log codes (see Microsoft's ExecutionLog3 documentation): rsSuccess is
// filtered out by the live query itself (see ssrsLiveSource.ts), so every fixture
// row here is a genuine non-success status, matching what the live query would
// actually return.
export const executionLogFixture: SsrsExecutionLogRow[] = [
  {
    instance_name: "SSRS01",
    report_path: "/Finance/MonthlyRevenue",
    user_name: "svc-report-runner",
    status: "rsProcessingAborted",
    time_start: "2026-08-24T08:12:03Z",
    time_end: "2026-08-24T08:22:03Z",
    time_data_retrieval_ms: 601000,
    time_processing_ms: 0,
    time_rendering_ms: 0,
  },
  {
    instance_name: "SSRS01",
    report_path: "/Ops/DailyIncidentSummary",
    user_name: "quincy",
    status: "rsCannotSetProcessingProperty",
    time_start: "2026-08-24T07:55:41Z",
    time_end: "2026-08-24T07:55:44Z",
    time_data_retrieval_ms: 0,
    time_processing_ms: 0,
    time_rendering_ms: 0,
  },
];
