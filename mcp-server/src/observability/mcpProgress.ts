// Shared MCP progress-notification helper (notifications/progress). Every tool
// whose real work can run past ~2s (a live SQL/SSRS query with retries, an MCP
// sampling round-trip) uses this instead of building its own notification
// object inline — read_sql_server_dmv used to do exactly that, duplicated,
// before this file existed.
//
// Opt-in per MCP spec: a client that never attached a progressToken to its
// request gets makeProgressEmitter() => null, and every call site below treats
// null as "do nothing" — the tool behaves identically to a client with no
// progress interest at all, never an extra notification it didn't ask for.

import type { ProgressNotification } from "@modelcontextprotocol/sdk/types.js";

export interface ProgressCapableExtra {
  _meta?: { progressToken?: string | number };
  // A function accepting the wider real ServerNotification union (as every
  // actual tool's `extra.sendNotification` does) satisfies this narrower
  // "accepts at least a ProgressNotification" requirement -- accepting more
  // than required is fine, accepting less isn't.
  sendNotification: (notification: ProgressNotification) => Promise<void>;
}

export interface ProgressEmitter {
  // total omitted (undefined) means genuinely unknown -- the caller must pass
  // a message saying so, never a fabricated percentage. total present means a
  // real, known denominator (a real attempt cap, a real fetch count), never
  // invented.
  send(progress: number, total: number | undefined, message: string): void;
}

export function makeProgressEmitter(extra: ProgressCapableExtra): ProgressEmitter | null {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) {
    return null;
  }
  return {
    send(progress, total, message) {
      void extra.sendNotification({
        method: "notifications/progress",
        params: total === undefined ? { progressToken, progress, message } : { progressToken, progress, total, message },
      });
    },
  };
}
