/**
 * Unit tests for `kotlinProvider.descriptionExtractor` (issue #2270, U3).
 *
 * Confirms Kotlin function/type KDoc is surfaced as the symbol `description`,
 * mirroring the Java behavior. Drives the real provider hook with a captureMap
 * built from a parsed tree.
 */
import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import { requireVendoredGrammar } from '../../src/core/tree-sitter/vendored-grammars.js';
import { kotlinProvider } from '../../src/core/ingestion/languages/kotlin.js';
import type { CaptureMap } from '../../src/core/ingestion/language-provider.js';

// Vendored grammar — loaded from vendor/ by absolute path, never node_modules (#2111).
const Kotlin = requireVendoredGrammar('tree-sitter-kotlin');

function captureMapFor(src: string, nodeType: string, captureKey: string): CaptureMap {
  const parser = new Parser();
  parser.setLanguage(Kotlin);
  const node = parser.parse(src).rootNode.descendantsOfType(nodeType)[0];
  expect(node, `expected a ${nodeType} node`).toBeDefined();
  return { [captureKey]: node };
}

const PROBE = `package demo
class Probe {
  /**
   * Computes the running balance, use computeBalanceV2
   */
  fun computeBalance(userId: Long): String? { return null }
}`;

describe('kotlinProvider.descriptionExtractor', () => {
  it('is registered on the provider (regression guard for issue #2270)', () => {
    expect(kotlinProvider.descriptionExtractor).toBeDefined();
  });

  it('extracts the function KDoc, including the marker term', () => {
    const captureMap = captureMapFor(PROBE, 'function_declaration', 'definition.method');
    const description = kotlinProvider.descriptionExtractor?.(
      'Method',
      'computeBalance',
      captureMap,
    );
    expect(description).toContain('Computes the running balance');
    expect(description).toContain('computeBalanceV2');
  });

  it('extracts class-level KDoc', () => {
    const captureMap = captureMapFor(
      `/**\n * A probe class.\n */\nclass Probe`,
      'class_declaration',
      'definition.class',
    );
    expect(kotlinProvider.descriptionExtractor?.('Class', 'Probe', captureMap)).toBe(
      'A probe class.',
    );
  });

  it('returns undefined for a Kotlin function with no KDoc', () => {
    const captureMap = captureMapFor(
      `fun m(): String? { return null }`,
      'function_declaration',
      'definition.method',
    );
    expect(kotlinProvider.descriptionExtractor?.('Function', 'm', captureMap)).toBeUndefined();
  });
});
