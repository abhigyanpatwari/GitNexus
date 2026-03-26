/**
 * Built-in name filtering — identifies standard library functions and common noise
 * that should not be tracked as call targets in the knowledge graph.
 *
 * Language-specific entries live in each language provider's `builtInNames` field
 * (defined in languages/*.ts). This module provides the lookup function.
 */

import type { LanguageProvider } from '../language-provider.js';

/** Check if a name is a built-in or common noise for the given language. */
export const isBuiltInOrNoise = (name: string, provider: LanguageProvider): boolean =>
  provider.builtInNames?.has(name) ?? false;
