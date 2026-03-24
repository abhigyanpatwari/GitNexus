/**
 * Ingestion utilities barrel — re-exports from focused modules for backward compatibility.
 *
 * New code should import directly from the focused module:
 *   - noise-filter.ts: BUILT_IN_NAMES, isBuiltInOrNoise
 *   - language-detection.ts: getLanguageFromFilename
 *   - ast-helpers.ts: AST traversal, label classification, signature extraction
 *   - call-analysis.ts: call form inference, receiver extraction, chain analysis
 */

/**
 * Yield control to the event loop so spinners/progress can render.
 * Call periodically in hot loops to prevent UI freezes.
 */
export const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

export const isVerboseIngestionEnabled = (): boolean => {
  const raw = process.env.GITNEXUS_VERBOSE;
  if (!raw) return false;
  const value = raw.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
};

// Re-exports for backward compatibility — new code should import from focused modules directly
export { BUILT_IN_NAMES, isBuiltInOrNoise } from './noise-filter.js';
export { getLanguageFromFilename } from './language-detection.js';
export * from './ast-helpers.js';
export * from './call-analysis.js';
