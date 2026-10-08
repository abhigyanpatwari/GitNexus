import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import R from '@eagleoutice/tree-sitter-r';
import { countCallArguments } from '../../src/core/ingestion/utils/call-analysis.js';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';
import { SupportedLanguages } from 'gitnexus-shared';
import { getProvider } from '../../src/core/ingestion/languages/index.js';

function extractRCall(
  code: string,
  calledName: string,
): { callNode: SyntaxNode; nameNode: SyntaxNode } | undefined {
  const parser = new Parser();
  parser.setLanguage(R);

  const provider = getProvider(SupportedLanguages.R);
  const tree = parser.parse(code);
  const query = new Parser.Query(parser.getLanguage(), provider.treeSitterQueries);

  for (const match of query.matches(tree.rootNode)) {
    const captureMap: Record<string, SyntaxNode> = {};
    for (const capture of match.captures) {
      captureMap[capture.name] = capture.node;
    }
    if (captureMap['call'] && captureMap['call.name']?.text === calledName) {
      return { callNode: captureMap['call'], nameNode: captureMap['call.name'] };
    }
  }

  return undefined;
}

describe('countCallArguments (R)', () => {
  it('returns 0 for empty-argument calls in pipe chains', () => {
    const cleanCall = extractRCall('data |> clean_native() |> transform_native()', 'clean_native');
    const transformCall = extractRCall(
      'data |> clean_native() |> transform_native()',
      'transform_native',
    );

    expect(cleanCall).toBeDefined();
    expect(transformCall).toBeDefined();
    // countCallArguments counts explicit arguments only — pipe LHS is not in the call node
    expect(countCallArguments(cleanCall!.callNode)).toBe(0);
    expect(countCallArguments(transformCall!.callNode)).toBe(0);
  });

  it('returns 0 for empty-argument magrittr pipe calls', () => {
    const cleanCall = extractRCall(
      'data %>% clean_magrittr() %>% transform_magrittr()',
      'clean_magrittr',
    );
    const transformCall = extractRCall(
      'data %>% clean_magrittr() %>% transform_magrittr()',
      'transform_magrittr',
    );

    expect(cleanCall).toBeDefined();
    expect(transformCall).toBeDefined();
    expect(countCallArguments(cleanCall!.callNode)).toBe(0);
    expect(countCallArguments(transformCall!.callNode)).toBe(0);
  });

  it('counts explicit arguments in ordinary R calls', () => {
    const multiArgCall = extractRCall('transform_magrittr(first, second)', 'transform_magrittr');

    expect(multiArgCall).toBeDefined();
    // tree-sitter-r produces: argument("first"), comma(","), argument("second")
    // countCallArguments counts all named non-comment children
    const count = countCallArguments(multiArgCall!.callNode);
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('counts explicit arguments when magrittr uses the dot placeholder', () => {
    const placeholderCall = extractRCall(
      'data %>% transform_magrittr(., extra)',
      'transform_magrittr',
    );

    expect(placeholderCall).toBeDefined();
    const count = countCallArguments(placeholderCall!.callNode);
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
