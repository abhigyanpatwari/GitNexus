/**
 * Response shape extraction from route handler file content.
 * Detects .json() calls (JS/TS) and json_encode() calls (PHP),
 * extracts top-level keys, and classifies by HTTP status code.
 */

/** Return the status code (group 1) from the last match, or undefined. */
function lastMatchGroup(text: string, pattern: RegExp): number | undefined {
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) return undefined;
  return parseInt(matches[matches.length - 1][1], 10);
}

/** Build the {responseKeys, errorKeys} result, deduplicating and omitting empty. */
function buildShapeResult(
  successKeys: string[],
  errKeys: string[],
): { responseKeys?: string[]; errorKeys?: string[] } {
  return {
    ...(successKeys.length > 0 ? { responseKeys: [...new Set(successKeys)] } : {}),
    ...(errKeys.length > 0 ? { errorKeys: [...new Set(errKeys)] } : {}),
  };
}

/**
 * Detect an HTTP status code associated with a .json() call.
 */
export function detectStatusCode(content: string, jsonMatchPos: number, closingBracePos: number): number | undefined {
  const lookbackStart = Math.max(0, jsonMatchPos - 200);
  const before = content.slice(lookbackStart, jsonMatchPos);
  const statusChainMatch = before.match(/\.status\s*\(\s*(\d{3})\s*\)\s*$/);
  if (statusChainMatch) {
    return parseInt(statusChainMatch[1], 10);
  }
  if (closingBracePos > 0) {
    const afterFirstArg = content.slice(closingBracePos + 1, closingBracePos + 150);
    const secondArgMatch = afterFirstArg.match(/^\s*,\s*\{[^}]*status\s*:\s*(\d{3})/);
    if (secondArgMatch) {
      return parseInt(secondArgMatch[1], 10);
    }
  }
  const extendedBefore = content.slice(Math.max(0, jsonMatchPos - 300), jsonMatchPos);
  if (/new\s+Response\s*\(\s*JSON\s*\.stringify\s*$/.test(extendedBefore) && closingBracePos > 0) {
    const afterStringify = content.slice(closingBracePos + 1, closingBracePos + 200);
    const respStatusMatch = afterStringify.match(/^\s*\)\s*,\s*\{[^}]*status\s*:\s*(\d{3})/);
    if (respStatusMatch) {
      return parseInt(respStatusMatch[1], 10);
    }
  }
  return undefined;
}

/**
 * Extract response shapes from JS/TS handler file content.
 */
export function extractResponseShapes(content: string): { responseKeys?: string[]; errorKeys?: string[] } {
  const successKeys: string[] = [];
  const errKeys: string[] = [];
  const jsonPattern = /\.json\s*\(/g;
  let jsonMatch;
  while ((jsonMatch = jsonPattern.exec(content)) !== null) {
    const matchPos = jsonMatch.index;
    const startIdx = matchPos + jsonMatch[0].length;
    let i = startIdx;
    while (i < content.length && content[i] !== '{' && content[i] !== ')') i++;
    if (i >= content.length || content[i] !== '{') continue;
    const callKeys: string[] = [];
    let depth = 0;
    let keyStart = -1;
    let inString: string | null = null;
    let closingBracePos = -1;
    for (let j = i; j < content.length; j++) {
      const ch = content[j];
      if (inString) {
        if (ch === '\\') { j++; continue; }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        // Quoted string at depth 1 before ':' is a property key (e.g., { 'courses': data })
        // The original parser only handled unquoted identifiers.
        if (depth === 1 && keyStart === -1) {
          const quote = ch;
          const strStart = j + 1;
          let strEnd = -1;
          for (let s = strStart; s < content.length; s++) {
            if (content[s] === '\\') { s++; continue; }
            if (content[s] === quote) { strEnd = s; break; }
          }
          if (strEnd !== -1) {
            // Scan forward for ':' without allocating a substring
            let p = strEnd + 1;
            while (p < content.length && (content[p] === ' ' || content[p] === '\t' || content[p] === '\n' || content[p] === '\r')) p++;
            if (content[p] === ':') {
              callKeys.push(content.slice(strStart, strEnd));
            }
            j = strEnd;
            continue;
          }
        }
        inString = ch;
        continue;
      }
      if (ch === '{') { depth++; continue; }
      if (ch === '}') { depth--; if (depth === 0) { closingBracePos = j; break; } continue; }
      if (depth !== 1) continue;
      if (keyStart === -1 && /[a-zA-Z_$]/.test(ch)) {
        keyStart = j;
      } else if (keyStart !== -1 && !/[a-zA-Z0-9_$]/.test(ch)) {
        const key = content.slice(keyStart, j);
        const rest = content.slice(j).trimStart();
        if (rest[0] === ':' || rest[0] === ',' || rest[0] === '}') {
          callKeys.push(key);
        }
        keyStart = -1;
      }
    }
    if (callKeys.length === 0) continue;
    const status = detectStatusCode(content, matchPos, closingBracePos);
    if (status !== undefined && status >= 400) {
      errKeys.push(...callKeys);
    } else {
      successKeys.push(...callKeys);
    }
  }
  return buildShapeResult(successKeys, errKeys);
}

/**
 * Find the last exit/die boundary in a string.
 * Matches: exit; exit(N); die; die('msg'); die($var);
 * Returns the index AFTER the boundary.
 */
function findLastExitBoundary(text: string): number {
  const pattern = /\b(exit|die)\s*(\([^)]*\))?\s*;/g;
  let lastEnd = -1;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    lastEnd = m.index + m[0].length;
  }
  return lastEnd;
}

function detectPHPStatusCode(content: string, jsonEncodePos: number): number | undefined {
  const lookbackStart = Math.max(0, jsonEncodePos - 300);
  let before = content.slice(lookbackStart, jsonEncodePos);
  const boundaryEnd = findLastExitBoundary(before);
  if (boundaryEnd !== -1) {
    before = before.slice(boundaryEnd);
  }
  return lastMatchGroup(before, /http_response_code\s*\(\s*(\d{3})\s*\)/g)
    ?? lastMatchGroup(before, /header\s*\(\s*['"]HTTP\/[\d.]+\s+(\d{3})/g)
    // CGI/FastCGI format
    ?? lastMatchGroup(before, /header\s*\(\s*['"]Status:\s*(\d{3})/g);
}

function findMatchingBracket(content: string, openPos: number, open: string, close: string): number {
  let depth = 0;
  let inString: string | null = null;
  for (let j = openPos; j < content.length; j++) {
    const ch = content[j];
    if (inString) {
      if (ch === '\\') { j++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = ch; continue; }
    if (ch === open) { depth++; continue; }
    if (ch === close) { depth--; if (depth === 0) return j; continue; }
  }
  return -1;
}

function extractPHPArrayKeys(arrayContent: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  const topLevelRanges: Array<[number, number]> = [];
  let rangeStart = 0;
  for (let i = 0; i < arrayContent.length; i++) {
    const ch = arrayContent[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = ch; continue; }
    if (ch === '[' || ch === '(' || ch === '{') {
      if (depth === 0) topLevelRanges.push([rangeStart, i]);
      depth++;
    } else if (ch === ']' || ch === ')' || ch === '}') {
      depth--;
      if (depth === 0) rangeStart = i + 1;
    }
  }
  if (depth === 0) topLevelRanges.push([rangeStart, arrayContent.length]);
  for (const [start, end] of topLevelRanges) {
    const segment = arrayContent.slice(start, end);
    const localPattern = /(['"])([a-zA-Z_][a-zA-Z0-9_]*)\1\s*=>/g;
    let m;
    while ((m = localPattern.exec(segment)) !== null) {
      keys.push(m[2]);
    }
  }
  return keys;
}

export function extractPHPResponseShapes(content: string): { responseKeys?: string[]; errorKeys?: string[] } {
  const successKeys: string[] = [];
  const errKeys: string[] = [];
  const jsonEncodePattern = /json_encode\s*\(/g;
  let match;
  while ((match = jsonEncodePattern.exec(content)) !== null) {
    const matchPos = match.index;
    const startIdx = matchPos + match[0].length;
    let i = startIdx;
    while (i < content.length && /\s/.test(content[i])) i++;
    if (i >= content.length) continue;
    let arrayEnd = -1;
    const openChar = content[i];
    if (openChar === '[') {
      arrayEnd = findMatchingBracket(content, i, '[', ']');
    } else if (content.slice(i, i + 6) === 'array(') {
      i += 5;
      arrayEnd = findMatchingBracket(content, i, '(', ')');
    } else {
      continue;
    }
    if (arrayEnd === -1) continue;
    const arrayContent = content.slice(i + 1, arrayEnd);
    const callKeys = extractPHPArrayKeys(arrayContent);
    if (callKeys.length === 0) continue;
    const status = detectPHPStatusCode(content, matchPos);
    if (status !== undefined && status >= 400) {
      errKeys.push(...callKeys);
    } else {
      successKeys.push(...callKeys);
    }
  }
  return buildShapeResult(successKeys, errKeys);
}
