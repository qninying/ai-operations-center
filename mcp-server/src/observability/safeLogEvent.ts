import { logEvent, type LogEventInput } from "./logger.js";

// Extracted from monitoringService.ts / escalationService.ts (STORY-008/009), each of
// which had its own copy of this exact guard — this is the third occurrence
// (notificationService.ts, STORY-010), which is this repo's own threshold for lifting
// duplicated logic (see CLAUDE.md's Modular Composition Rule).
//
// A caller whose own logging call throws should not crash or lose the event — this is
// the last line of defense for any "log failure" failure path. callerLabel keeps the
// console.error fallback attributable to whichever service it fired from, matching
// each service's pre-extraction message text exactly (e.g. "monitoringService: logEvent
// failed") so existing tests asserting that text needed no changes.
export function safeLogEvent(callerLabel: string, input: LogEventInput): void {
  try {
    logEvent(input);
  } catch (error) {
    try {
      console.error(`${callerLabel}: logEvent failed`, error);
    } catch {
      // A deliberate, audited exception to CLAUDE.md's "never swallow an error"
      // rule, not an oversight — reviewed directly during a codebase-wide catch-
      // block audit and kept as-is. This is the fallback-of-a-fallback: it exists
      // specifically for console.error() itself throwing (e.g. a closed stdout/
      // stderr), and there is no lower sink left to report to. Writing to a file
      // as a third fallback would just move the same "what if this write also
      // fails" problem one level deeper, not resolve it.
    }
  }
}
