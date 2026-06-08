/**
 * Per-language source/sink/sanitizer registry seam (issue #2080).
 *
 * A keyed registry of {@link SourceSinkSanitizerSpec} by language id. M0 stands
 * up the empty seam — no language is registered and nothing in the pipeline
 * reads it. M3 (#2083) registers per-language specs and queries this registry
 * when emitting taint edges.
 *
 * The store is module-level (matching the codebase's other per-language
 * registries). {@link clearSourceSinkRegistry} resets it for test isolation.
 */

import type { SourceSinkSanitizerSpec } from './source-sink-config.js';

const registry = new Map<string, SourceSinkSanitizerSpec>();

/**
 * Register the taint config for a language. Last-write-wins: re-registering
 * the same `languageId` overwrites the previous spec (so M3 can override a
 * built-in default). Returns nothing.
 */
export function registerSourceSinkConfig(languageId: string, spec: SourceSinkSanitizerSpec): void {
  registry.set(languageId, spec);
}

/**
 * Look up the taint config for a language. Returns `undefined` when no spec is
 * registered (the M0 default for every language) — never throws.
 */
export function getSourceSinkConfig(languageId: string): SourceSinkSanitizerSpec | undefined {
  return registry.get(languageId);
}

/** Language ids that currently have a registered spec. Empty in M0. */
export function registeredTaintLanguages(): string[] {
  return [...registry.keys()];
}

/** Reset the registry. Primarily for test isolation. */
export function clearSourceSinkRegistry(): void {
  registry.clear();
}
