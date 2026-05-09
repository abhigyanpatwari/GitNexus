/**
 * CLI message helpers — for user-facing banners, error guidance, and
 * recovery hints emitted by `gitnexus` subcommands.
 *
 * These functions write **plain text** directly to `process.stderr` AND
 * tee a structured pino record through the singleton `logger`. Plain text
 * preserves the human-readable contract for users running `gitnexus`
 * interactively, redirecting to a file, or piping to `cat`/`grep`. The
 * structured tee keeps log aggregators happy.
 *
 * **Use these for:**
 *   - User-facing banners ("Server listening on http://...:N")
 *   - Validation errors ("--worker-timeout must be at least 1 second")
 *   - Recovery hints ("Suggestions: 1. Clear the npm cache, 2. ...")
 *   - One-line user notices ("No indexed repositories found.")
 *
 * **Do NOT use these for:**
 *   - Internal diagnostics (worker progress, retry counts, telemetry)
 *     — use `logger.info`/`warn`/`error` directly. Internal logs only
 *     need structured fields, not double-output to stderr.
 *   - High-volume hot paths — every `cliMessage` call writes twice (raw
 *     + structured). Acceptable for user-facing messages, wasteful for
 *     ingestion pipeline events.
 *
 * Design note: stderr is the right channel even for non-error messages
 * because GitNexus CLI tools (`query`, `cypher`, `impact`) emit JSON
 * data on stdout for piping (`gitnexus query | jq`). User banners on
 * stdout would corrupt that pipeline.
 */
import { logger } from '../core/logger.js';

function writeStderr(msg: string): void {
  // Direct write — bypassing `console.*` so it cannot be intercepted by
  // progress-bar redirection (see `cli/analyze.ts:barLog`) or other
  // routing. The structured tee below still goes through the logger so
  // log aggregation works either way.
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n');
}

/**
 * User-facing informational message. Use for banners, listening URLs,
 * and any message the user expects to read in plain text.
 */
export function cliInfo(msg: string, fields?: Record<string, unknown>): void {
  writeStderr(msg);
  logger.info(fields ?? {}, msg);
}

/**
 * User-facing warning. Operator-actionable but non-fatal — `cliWarn`
 * indicates the command can still proceed in some form.
 */
export function cliWarn(msg: string, fields?: Record<string, unknown>): void {
  writeStderr(msg);
  logger.warn(fields ?? {}, msg);
}

/**
 * User-facing error. Indicates the command cannot proceed; usually
 * paired with a non-zero exit code at the call site.
 */
export function cliError(msg: string, fields?: Record<string, unknown>): void {
  writeStderr(msg);
  logger.error(fields ?? {}, msg);
}
