import { open, stat } from "node:fs/promises";

// Reads a diagnostic log file already confirmed to be inside an allowed root
// by resolveWithinRoots() (security/rootsEnforcement.ts) -- this module has no
// opinion about where the file is allowed to live, only about how much of it
// is safe to load into memory and how it's shaped once read. Kept separate
// from the roots-containment check for the same reason dmvReader.ts stays
// separate from dmvLiveSource.ts: one responsibility per module, each
// directly unit-testable on its own, per this repo's own composition rules.

const DEFAULT_MAX_LINES = 200;
// Caps how much of a large file is ever loaded into memory, regardless of how
// many lines are requested -- an unbounded read of an arbitrarily large file
// is the filesystem equivalent of an unbounded external call with no timeout.
const DEFAULT_MAX_READ_BYTES = 1_000_000;

export interface DiagnosticLogReadOptions {
  maxLines?: number;
  maxReadBytes?: number;
}

export interface DiagnosticLogReadResult {
  lines: string[];
  // null when the file was larger than maxReadBytes -- only the tail was
  // ever read, so the true total line count in the file is unknown, and
  // reporting a wrong number would be worse than reporting none.
  totalLinesInFile: number | null;
  truncatedBySize: boolean;
  truncatedByLineCount: boolean;
}

export async function readDiagnosticLogFile(
  realPath: string,
  options: DiagnosticLogReadOptions = {}
): Promise<DiagnosticLogReadResult> {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;

  const { size } = await stat(realPath);
  const truncatedBySize = size > maxReadBytes;
  const readLength = Math.min(size, maxReadBytes);
  const startPosition = truncatedBySize ? size - maxReadBytes : 0;

  const handle = await open(realPath, "r");
  try {
    const buffer = Buffer.alloc(readLength);
    await handle.read(buffer, 0, readLength, startPosition);
    const text = buffer.toString("utf-8");
    // A genuinely empty file/read splits to [""], not [] -- an empty result
    // set should report zero lines, not one blank one.
    const allLines = text.length === 0 ? [] : text.split("\n");

    const truncatedByLineCount = allLines.length > maxLines;
    // A diagnostic log's most recent entries are what matter -- tail the
    // result, not head it.
    const lines = allLines.slice(-maxLines);

    return {
      lines,
      totalLinesInFile: truncatedBySize ? null : allLines.length,
      truncatedBySize,
      truncatedByLineCount,
    };
  } finally {
    await handle.close();
  }
}
