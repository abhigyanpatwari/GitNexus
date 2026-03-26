/**
 * SWR state slot detector.
 *
 * Detects `useSWR` and `useSWRMutation` calls and extracts cache keys,
 * enclosing function names, and consumer access patterns.
 */

import type { ExtractedStateSlot } from './types.js';
import { extractPropertyAccessKeys, extractDestructuredKeys } from '../shape-inference.js';

/**
 * Extract the first argument (cache key) text from a useSWR/useSWRMutation call.
 * Handles string literals, array literals, and template literals.
 *
 * @param code - Full file source
 * @param callStart - Index of the opening paren of the call
 */
function extractFirstArg(code: string, callStart: number): string {
  let depth = 0;
  let argStart = -1;
  let i = callStart;

  // Find the opening paren
  while (i < code.length && code[i] !== '(') i++;
  if (i >= code.length) return '';

  i++; // skip '('
  // Skip whitespace
  while (i < code.length && /\s/.test(code[i])) i++;

  argStart = i;

  // Walk until we hit a top-level comma or closing paren
  let inString: string | null = null;
  let inTemplate = false;
  let templateDepth = 0;

  for (; i < code.length; i++) {
    const ch = code[i];

    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }

    if (inTemplate) {
      if (ch === '\\') { i++; continue; }
      if (ch === '`') { inTemplate = false; continue; }
      if (ch === '$' && code[i + 1] === '{') { templateDepth++; i++; continue; }
      if (ch === '}' && templateDepth > 0) { templateDepth--; continue; }
      continue;
    }

    if (ch === '"' || ch === "'") { inString = ch; continue; }
    if (ch === '`') { inTemplate = true; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break; // end of call
      depth--;
      continue;
    }
    if (ch === ',' && depth === 0) break; // end of first arg
  }

  return code.slice(argStart, i).trim();
}

/**
 * Find the name of the enclosing function for the given position in source.
 */
function findEnclosingFunction(code: string, position: number): string {
  const before = code.slice(0, position);

  // Try: function Name( or async function Name(
  const funcDecl = [...before.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)];
  if (funcDecl.length > 0) {
    return funcDecl[funcDecl.length - 1][1];
  }

  // Try: const Name = ( or const Name = async (
  const arrowDecl = [...before.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?/g)];
  if (arrowDecl.length > 0) {
    return arrowDecl[arrowDecl.length - 1][1];
  }

  return '<anonymous>';
}

/**
 * Get a window of source code around a position for consumer analysis.
 */
function getContextWindow(code: string, position: number, chars = 800): string {
  const start = Math.max(0, position - 100);
  const end = Math.min(code.length, position + chars);
  return code.slice(start, end);
}

/**
 * Count newlines up to a position to get 1-based line number.
 */
function lineNumberAt(code: string, position: number): number {
  let count = 1;
  for (let i = 0; i < position; i++) {
    if (code[i] === '\n') count++;
  }
  return count;
}

/**
 * Detect all useSWR and useSWRMutation calls in a source file and return
 * extracted state slots.
 *
 * @param code - File source text
 * @param filePath - Absolute path of the file (used in output)
 */
export function detectSwrSlots(code: string, filePath: string): ExtractedStateSlot[] {
  const slots: ExtractedStateSlot[] = [];

  // Match useSWR( and useSWRMutation(
  const pattern = /\buseSWR(Mutation)?\s*(?:<[^>]*>)?\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    const isMutation = Boolean(match[1]);
    const callIndex = match.index;

    const cacheKey = extractFirstArg(code, callIndex);
    if (!cacheKey) continue;

    const lineNumber = lineNumberAt(code, callIndex);
    const enclosingFn = findEnclosingFunction(code, callIndex);
    const contextWindow = getContextWindow(code, callIndex);

    // Collect consumer access patterns from the surrounding context
    const accessedKeys = [
      ...extractPropertyAccessKeys(contextWindow),
      ...extractDestructuredKeys(contextWindow),
    ];
    const uniqueKeys = [...new Set(accessedKeys)];

    const slot: ExtractedStateSlot = {
      name: cacheKey,
      slotKind: 'swr',
      cacheKey,
      filePath,
      lineNumber,
      producers: [],
      consumers: uniqueKeys.length > 0
        ? [
            {
              functionName: enclosingFn,
              filePath,
              lineNumber,
              accessedKeys: uniqueKeys,
              confidence: 'heuristic',
            },
          ]
        : [],
    };

    slots.push(slot);
  }

  return slots;
}
