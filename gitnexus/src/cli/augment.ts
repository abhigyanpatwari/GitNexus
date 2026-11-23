/**
 * Augment CLI Command
 *
 * Fast-path command for platform hooks.
 * Shells out from Claude Code PreToolUse / Cursor postToolUse hooks.
 *
 * Usage: gitnexus augment <pattern...>
 * Several patterns come from one search with alternatives
 * (`rg -e FooService -e BarService`). Writes the enriched text to stderr.
 *
 * Performance: Must cold-start fast (<500ms).
 * Skips unnecessary initialization (no web server, no full DB warmup).
 */

import { augment } from '../core/augmentation/engine.js';

export async function augmentCommand(patterns: readonly string[]): Promise<void> {
  if (patterns.every((pattern) => pattern.length < 3)) {
    process.exit(0);
  }

  try {
    const result = await augment(patterns, process.cwd());

    if (result) {
      // IMPORTANT: Write to stderr, NOT stdout.
      // LadybugDB's native module captures stdout fd at OS level during init,
      // which makes stdout permanently broken in subprocess contexts.
      // stderr is never captured, so it works reliably everywhere.
      // The hook reads from the subprocess's stderr.
      process.stderr.write(result + '\n');
    }
  } catch {
    // Graceful failure — never break the calling hook
    process.exit(0);
  }
}
