/** Collect URL-bearing calls while the provider's existing AST is available. */
import type Parser from 'tree-sitter';
import type { ExtractedFetchCall } from '../workers/parse-worker.js';

/** A candidate is not an HTTP sink until its name matches a known wrapper. */
export interface FetchWrapperCall extends ExtractedFetchCall {
  functionName: string;
}

function calleeName(node: Parser.SyntaxNode | null): string | undefined {
  // The TS grammar puts `await f<T>(...)` inside the call's function field.
  while (node?.type === 'await_expression') {
    node = node.namedChildren.find((child) => child.type !== 'comment') ?? null;
  }
  // Unlike constant names, configured wrapper names may start with this/super.
  const parts: string[] = [];
  while (node?.type === 'member_expression') {
    const property = node.childForFieldName('property');
    if (property?.type !== 'property_identifier') return undefined;
    parts.push(property.text);
    node = node.childForFieldName('object');
  }
  if (!node || !['identifier', 'this', 'super'].includes(node.type)) return undefined;
  parts.push(node.text);
  return parts.reverse().join('.');
}

export function extractFetchWrapperCalls(
  tree: Parser.Tree,
  filePath: string,
  lineOffset: number,
): FetchWrapperCall[] {
  const calls: FetchWrapperCall[] = [];
  for (const call of tree.rootNode.descendantsOfType('call_expression')) {
    if (call.hasError) continue;
    const argument = call
      .childForFieldName('arguments')
      ?.namedChildren.find((child) => child.type !== 'comment');
    if (argument?.type !== 'string' && argument?.type !== 'template_string') continue;
    // Keep template substitutions for the existing route URL normalizer.
    // Requiring the whole argument to be a literal excludes concatenation.
    const fetchURL = argument.text.slice(1, -1);
    if (!fetchURL.startsWith('/')) continue;
    const functionName = calleeName(call.childForFieldName('function'));
    if (!functionName) continue;
    calls.push({
      filePath,
      functionName,
      fetchURL,
      lineNumber: call.startPosition.row + lineOffset + 1,
    });
  }
  return calls;
}
