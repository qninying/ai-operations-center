# sample-logs/

Representative sample data for `read_diagnostic_log_file` — a real file on disk
that the tool genuinely reads via real file I/O, not a live production log.
Matches the same "STUB: served from fixture data" disclosure pattern already
used for `dmvFixtures.ts`/`ssrsFixtures.ts`, just as a real file instead of an
in-memory array, since this tool's whole point is exercising a real filesystem
read path (and the roots guard in front of it) rather than in-memory data.

To try the tool locally: declare this directory (or its absolute path) as an
MCP root when connecting a client, then call `read_diagnostic_log_file` with
`sqlserver-errorlog-sample.txt`.
