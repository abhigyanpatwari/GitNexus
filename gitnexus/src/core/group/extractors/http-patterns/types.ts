import type Parser from 'tree-sitter';

/**
 * Shared types for the http-route-extractor language plugins.
 *
 * Each plugin lives in its own file (java.ts, node.ts, ...) and owns
 * the tree-sitter grammar import + queries. The top-level
 * `http-route-extractor.ts` orchestrator only knows about this type
 * module and the plugin registry (`./index.ts`). It MUST NOT import
 * any grammar or query text directly — language-specific knowledge
 * belongs in the plugins.
 */

export type HttpRole = 'provider' | 'consumer';

/**
 * One raw HTTP detection produced by a plugin's `scan()` function. The
 * orchestrator converts this into a full `ExtractedContract` by running
 * path normalization and building the contract id.
 *
 * `path` is the raw literal string as it appeared in source (with
 * `${...}` template placeholders still in place); the orchestrator
 * runs the appropriate normalizer for provider vs. consumer paths.
 */
export interface HttpDetection {
  role: HttpRole;
  /** Short framework label, e.g. `'spring'`, `'nest'`, `'express'`. */
  framework: string;
  /** HTTP method in upper case (`'GET'`, `'POST'`, ...). */
  method: string;
  /** Raw path literal as seen in source (template placeholders intact). */
  path: string;
  /**
   * Symbol name of the handler (for providers) or calling function
   * (for consumers) when the plugin can determine it structurally.
   * Null when no good candidate is available.
   */
  name: string | null;
  /** Confidence in (0, 1]. Source-scan plugins typically use 0.7–0.8. */
  confidence: number;
}

/**
 * One language-scoped HTTP plugin. The plugin owns the tree-sitter
 * grammar and the `scan` function that translates a parsed tree into
 * zero or more `HttpDetection`s. Plugins are free to run multiple
 * compiled pattern bundles internally (see the shared scanner's
 * `runCompiledPatterns` helper).
 *
 * `language` is typed as `unknown` for the same reason as
 * `LanguagePatterns.language` in `tree-sitter-scanner.ts` — the
 * grammar modules export different shapes.
 */
export interface HttpLanguagePlugin {
  /** Human-readable plugin name for diagnostics. */
  name: string;
  /** tree-sitter grammar object (passed to the shared parser). */
  language: unknown;
  /**
   * Scan a parsed tree and return zero or more HTTP detections. Plugins
   * must not throw — they should swallow per-match errors so a single
   * malformed construct does not abort the whole file.
   */
  scan(tree: Parser.Tree): HttpDetection[];
}
