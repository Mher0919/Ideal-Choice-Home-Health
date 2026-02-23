// logger.ts
// Append-only change log written to changes-log.txt next to main.ts.
// Each app run opens a new "Run MM/DD/YYYY - HH:MM:" block, then every
// recorded change is indented beneath it.  On the next run the new block
// is appended below the previous ones so the history is preserved.

import fs   from 'fs';
import path from 'path';

const LOG_FILE = path.join(__dirname, 'changes-log.txt');

// ── Internal state ───────────────────────────────────────────────────────────

const changes: string[] = [];   // lines collected during this run
let runHeader = '';              // "Run MM/DD/YYYY - HH:MM:"

// ── Helpers ──────────────────────────────────────────────────────────────────

function timestamp(): string {
  const now   = new Date();
  const mm    = String(now.getMonth() + 1).padStart(2, '0');
  const dd    = String(now.getDate()).padStart(2, '0');
  const yyyy  = now.getFullYear();
  const hh    = String(now.getHours()).padStart(2, '0');
  const min   = String(now.getMinutes()).padStart(2, '0');
  return `${mm}/${dd}/${yyyy} - ${hh}:${min}`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Call once at the very start of main() to open a new run block. */
export function startRun(): void {
  runHeader = `Run ${timestamp()}:`;
  changes.length = 0;
  console.log(`📋 Change log: ${LOG_FILE}`);
}

/**
 * Record a single change.  Call this every time something meaningful happens:
 * time filled, PDF downloaded, PDF uploaded, visit added, etc.
 *
 * @param patient   Patient full name, e.g. "Flores, Marlene"
 * @param message   Plain-English description of what changed
 */
export function logChange(patient: string, message: string): void {
  const line = `  [${patient}] ${message}`;
  changes.push(line);
  // Also echo to console so it's visible while running
  console.log(`📝 ${line.trim()}`);
}

/**
 * Call once at the very end of main() (or in a finally block) to flush
 * everything collected during this run to the log file.
 * If nothing was recorded, still writes a "No changes" line so every run
 * is represented in the file.
 */
export function flushLog(): void {
  if (!runHeader) return;   // startRun() was never called — nothing to write

  const body = changes.length > 0
    ? changes.join('\n')
    : '  (no changes this run)';

  const block = `${runHeader}\n${body}\n`;

  // Append separator + block to keep previous runs intact
  const separator = changes.length > 0 ? '\n' : '\n';
  fs.appendFileSync(LOG_FILE, separator + block, 'utf8');

  console.log(`\n📋 Change log updated → ${LOG_FILE}  (${changes.length} change(s) recorded)`);
}