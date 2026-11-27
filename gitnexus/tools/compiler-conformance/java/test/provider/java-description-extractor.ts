/**
 * Unit tests for `javaProvider.descriptionExtractor` (issue #2270, U2).
 *
 * Confirms Java method/type Javadoc is surfaced as the symbol `description`,
 * which is what reaches the embedding metadata header and makes Javadoc-only
 * terms semantically searchable. Drives the real provider hook with a captureMap
 * built from a parsed tree (matching what the parse worker passes in).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { javaProvider } from '../../../../../src/core/ingestion/languages/java.js';
import type { CaptureMap } from '../../../../../src/core/ingestion/language-provider.js';

function captureMapFor(src: string, nodeType: string, captureKey: string): CaptureMap {
  const parser = new Parser();
  parser.setLanguage(Java);
  const node = parser.parse(src).rootNode.descendantsOfType(nodeType)[0];
  assert.notEqual(node, undefined, `expected a ${nodeType} node`);
  return { [captureKey]: node };
}

const PROBE = `package demo;
public class Probe {
  /**
   * Computes the running balance across all user accounts.
   * @param userId the unique user identifier
   * @deprecated since 2.0, use computeBalanceV2
   */
  public java.math.BigDecimal computeBalance(Long userId) { return null; }
}`;

describe('javaProvider.descriptionExtractor', () => {
  it('is registered on the provider (regression guard for issue #2270)', () => {
    assert.notEqual(javaProvider.descriptionExtractor, undefined);
  });

  it('extracts the method Javadoc, including the @deprecated marker term', () => {
    const captureMap = captureMapFor(PROBE, 'method_declaration', 'definition.method');
    const description = javaProvider.descriptionExtractor?.('Method', 'computeBalance', captureMap);
    assert.ok(description.includes('Computes the running balance'));
    assert.ok(description.includes('computeBalanceV2'));
  });

  it('extracts class-level Javadoc', () => {
    const captureMap = captureMapFor(
      `/**\n * A probe class.\n */\npublic class Probe {}`,
      'class_declaration',
      'definition.class',
    );
    assert.equal(
      javaProvider.descriptionExtractor?.('Class', 'Probe', captureMap),
      'A probe class.',
    );
  });

  it('returns undefined for a Java method with no Javadoc', () => {
    const captureMap = captureMapFor(
      `class P { void m() {} }`,
      'method_declaration',
      'definition.method',
    );
    assert.equal(javaProvider.descriptionExtractor?.('Method', 'm', captureMap), undefined);
  });

  it('returns undefined for a non-doc-bearing label (e.g. Variable)', () => {
    // Even with a definition node present, a Variable label is out of scope.
    const captureMap = captureMapFor(PROBE, 'method_declaration', 'definition.method');
    assert.equal(javaProvider.descriptionExtractor?.('Variable', 'x', captureMap), undefined);
  });
});
