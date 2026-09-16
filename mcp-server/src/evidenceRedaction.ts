// AI Trust and Risk Review, 2026-09-15: no PHI or customer PII exists in this
// system's evidence today (confirmed by direct search), but nothing structurally
// prevented a credential-shaped string in a log/error field from reaching a Claude
// prompt or the pgvector semantic cache verbatim -- the adversarial eval suite's
// secretLeakageInEvidence probe (adversarialEval/probes.ts) proves the shape of
// that exposure by planting a real-looking connection-string password and
// checking whether the model echoes it back. That probe is a behavioral check on
// model output, run only in the eval harness; it is not a control on the real
// production data path. This module is that control: applied at the point
// evidence is serialized, before it reaches buildPrompt() or a cache writer, so
// a secret is scrubbed regardless of whether the model would have repeated it.

const REDACTED = "[REDACTED]";

// Order matters: connection-string passwords and URL-embedded basic-auth must be
// matched before the generic key/secret/token pattern, since a generic pattern
// alone would only replace the value after Password= and miss the surrounding
// context a reviewer would want to see redacted too. Each pattern replaces just
// the sensitive value, not the whole line, so the rest of the evidence (which
// field, which system) stays legible for diagnosis.
const PATTERNS: RegExp[] = [
  // Connection-string style: Password=...;  or  Pwd=...;
  /\b(Password|Pwd)=([^;"'\s]+)/gi,
  // URL-embedded basic auth: scheme://user:password@host
  /(:\/\/[^:/\s@]+):([^@\s]+)@/g,
  // Generic key/secret/token assignment: api_key=..., secret: "...", token=...
  /\b(api[_-]?key|secret|token|access[_-]?key)\s*[:=]\s*["']?([A-Za-z0-9\-_./+]{8,})["']?/gi,
  // AWS-style access key IDs
  /\bAKIA[0-9A-Z]{16}\b/g,
  // JWT-shaped three-segment base64 tokens
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
];

// Applied to one already-serialized string (e.g. JSON.stringify(evidence.data),
// or a built evidenceText block) rather than walking an arbitrary `unknown`
// value's shape -- evidence.data has no fixed structure across sources
// (dmvLiveSource, ssrsLiveSource, cloudBlobSource, diagnosticLogReader all
// differ), so redacting the serialized text is the one place that's structurally
// guaranteed to see every field, regardless of source shape.
export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of PATTERNS) {
    result = result.replace(pattern, (match, ...groups) => {
      if (pattern.source.startsWith("\\b(Password|Pwd)")) {
        return `${groups[0]}=${REDACTED}`;
      }
      if (pattern.source.startsWith("(:\\/\\/")) {
        return `${groups[0]}:${REDACTED}@`;
      }
      if (pattern.source.startsWith("\\b(api")) {
        return `${groups[0]}=${REDACTED}`;
      }
      return REDACTED;
    });
  }
  return result;
}
