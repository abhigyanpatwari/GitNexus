/**
 * queryClient.setQueryData / setQueriesData state slot detector.
 *
 * Detects programmatic cache mutations where code writes data directly to
 * the React Query cache without going through `useQuery`.
 */

import type { ExtractedStateSlot, ExtractedStateSlotProducer } from './types.js';
import { extractObjectLiteralKeys } from '../shape-inference.js';

const QC_SET_PATTERN = /\bqueryClient\s*\.\s*(setQueryData|setQueriesData)\s*\(/g;

/**
 * Count newlines up to a position to get 1-based line number.
 */
function lineNumberAt(source: string, pos: number): number {
  let count = 1;
  for (let i = 0; i < pos; i++) {
    if (source[i] === '\n') count++;
  }
  return count;
}

/**
 * Find the name of the enclosing function for the given position in source.
 * Uses last-match heuristic — picks the last declaration before the position,
 * which is usually the innermost. May be incorrect with interleaved declarations.
 */
function findEnclosingFunctionName(source: string, pos: number): string {
  const before = source.slice(0, pos);

  // Try: function Name( or async function Name(
  const funcDecl = [...before.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)];
  if (funcDecl.length > 0) {
    return funcDecl[funcDecl.length - 1][1];
  }

  // Try: const/let/var Name = ... =>
  const arrowDecl = [...before.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?/g)];
  if (arrowDecl.length > 0) {
    return arrowDecl[arrowDecl.length - 1][1];
  }

  return '<anonymous>';
}

/**
 * Extract the text of a single argument starting at `start` in `source`.
 * Stops at the top-level comma or closing paren (depth-aware, string-aware).
 */
function extractArg(source: string, start: number): string {
  let i = start;
  // Skip leading whitespace
  while (i < source.length && /\s/.test(source[i])) i++;

  const argStart = i;
  let depth = 0;
  let inString: string | null = null;
  let inTemplate = false;
  let templateDepth = 0;

  for (; i < source.length; i++) {
    const ch = source[i];

    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }

    if (inTemplate) {
      if (ch === '\\') { i++; continue; }
      if (ch === '`') { inTemplate = false; continue; }
      if (ch === '$' && source[i + 1] === '{') { templateDepth++; i++; continue; }
      if (ch === '}' && templateDepth > 0) { templateDepth--; continue; }
      continue;
    }

    if (ch === '"' || ch === "'") { inString = ch; continue; }
    if (ch === '`') { inTemplate = true; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth--;
      continue;
    }
    if (ch === ',' && depth === 0) break;
  }

  return source.slice(argStart, i).trim();
}

/**
 * Given the opening paren position of a call, extract the two arguments.
 * Returns [firstArg, secondArg] as raw text strings.
 */
function extractCallArgs(source: string, openParenPos: number): [string, string] {
  // openParenPos is '(' — skip it
  const afterParen = openParenPos + 1;

  const firstArg = extractArg(source, afterParen);
  // Advance past first arg and its trailing comma
  let i = afterParen;
  let depth = 0;
  let inString: string | null = null;
  let inTemplate = false;
  let templateDepth = 0;

  // Walk past whitespace
  while (i < source.length && /\s/.test(source[i])) i++;

  // Walk the first arg to find where it ends
  for (; i < source.length; i++) {
    const ch = source[i];

    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }

    if (inTemplate) {
      if (ch === '\\') { i++; continue; }
      if (ch === '`') { inTemplate = false; continue; }
      if (ch === '$' && source[i + 1] === '{') { templateDepth++; i++; continue; }
      if (ch === '}' && templateDepth > 0) { templateDepth--; continue; }
      continue;
    }

    if (ch === '"' || ch === "'") { inString = ch; continue; }
    if (ch === '`') { inTemplate = true; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) { return [firstArg, '']; }
      depth--;
      continue;
    }
    if (ch === ',' && depth === 0) {
      // Found the separator — second arg starts after this comma
      const secondArg = extractArg(source, i + 1);
      return [firstArg, secondArg];
    }
  }

  return [firstArg, ''];
}

/**
 * Extract a cache key from a `setQueriesData` filters object.
 * Looks for `queryKey: [...]` inside the filters object text.
 */
function extractQueryKeyFromFilters(filtersText: string): string | null {
  const pattern = /queryKey\s*:\s*(\[)/;
  const match = pattern.exec(filtersText);
  if (!match) return null;

  const bracketStart = filtersText.indexOf('[', match.index);
  if (bracketStart === -1) return null;

  let depth = 0;
  for (let i = bracketStart; i < filtersText.length; i++) {
    const ch = filtersText[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        return filtersText.slice(bracketStart, i + 1);
      }
    }
  }
  return null;
}

/**
 * Infer shape keys from the second argument of setQueryData.
 * If the second arg is an object literal `{ key: val, ... }`, extract top-level keys.
 * Otherwise fall back to extractObjectLiteralKeys on the whole arg text.
 */
function inferKeysFromDataArg(dataArg: string): string[] {
  if (!dataArg) return [];

  // Direct object literal: { total: 42, updated: true }
  const trimmed = dataArg.trim();
  if (trimmed.startsWith('{')) {
    // Use extractObjectLiteralKeys on a synthetic return statement so it matches
    return extractObjectLiteralKeys(`return ${trimmed}`);
  }

  return [];
}

/**
 * Detect queryClient.setQueryData and queryClient.setQueriesData calls in a source file.
 *
 * For each detected call:
 * - Extracts the cache key (first arg for setQueryData, queryKey inside filters for setQueriesData)
 * - Finds the enclosing function name (used as producer)
 * - Infers shape keys from the second argument if it is an object literal
 *
 * @param source  Raw source text of the file
 * @param filePath  Absolute path to the file (used for slot metadata)
 * @returns Array of ExtractedStateSlot records
 */
export function detectQueryClientSlots(source: string, filePath: string): ExtractedStateSlot[] {
  const slots: ExtractedStateSlot[] = [];

  let match: RegExpExecArray | null;
  const pattern = new RegExp(QC_SET_PATTERN.source, 'g');

  while ((match = pattern.exec(source)) !== null) {
    const methodName = match[1]; // 'setQueryData' or 'setQueriesData'
    const callStart = match.index;

    // Find the opening paren position (end of the matched text - 1 is '(')
    const openParenPos = callStart + match[0].length - 1;

    const [firstArg, secondArg] = extractCallArgs(source, openParenPos);
    if (!firstArg) continue;

    let cacheKey: string | null = null;

    if (methodName === 'setQueryData') {
      // First arg is the cache key directly
      cacheKey = firstArg;
    } else {
      // setQueriesData: first arg is a filters object, look for queryKey inside it
      cacheKey = extractQueryKeyFromFilters(firstArg);
    }

    if (!cacheKey) continue;

    const lineNumber = lineNumberAt(source, callStart);
    const enclosingFn = findEnclosingFunctionName(source, callStart);
    const inferredKeys = inferKeysFromDataArg(secondArg);

    const producer: ExtractedStateSlotProducer = {
      functionName: enclosingFn,
      filePath,
      lineNumber,
      keys: inferredKeys,
      confidence: 'heuristic',
    };

    const slot: ExtractedStateSlot = {
      name: cacheKey,
      slotKind: 'react-query',
      cacheKey,
      filePath,
      lineNumber,
      producers: [producer],
      consumers: [],
    };

    slots.push(slot);
  }

  return slots;
}
