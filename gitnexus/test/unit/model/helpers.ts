/**
 * Shared test helpers for the model/ unit tests.
 *
 * Keep this file minimal — just the factory functions that every
 * registry/table test needs. Anything domain-specific belongs in the
 * test file that uses it.
 */

import type { SymbolDefinition } from 'gitnexus-shared';

/**
 * Build a {@link SymbolDefinition} with sensible defaults. Every field
 * is overridable. Defaults produce a Method-typed def so the caller
 * only has to override for other shapes.
 */
export const makeDef = (overrides: Partial<SymbolDefinition> = {}): SymbolDefinition => ({
  nodeId: 'def:test',
  filePath: 'src/test.ts',
  type: 'Method',
  ...overrides,
});

/**
 * Alias for {@link makeDef} kept for readability in method-registry
 * tests where "makeMethod" reads more naturally at the call site.
 */
export const makeMethod = makeDef;
