/**
 * Response shape extraction from route handler file content.
 * Detects .json() calls, extracts top-level keys, and classifies by HTTP status code.
 */

/**
 * Detect an HTTP status code associated with a .json() call.
 * Looks for three patterns:
 * 1. `.status(N).json(` — Express style (look backwards from .json match)
 * 2. `.json({...}, { status: N })` — NextResponse style (look after closing brace of first arg)
 * 3. `new Response(JSON.stringify({...}), { status: N })` — raw Response constructor
 *
 * Returns the numeric status code, or undefined if none found.
 */
export function detectStatusCode(content: string, jsonMatchPos: number, closingBracePos: number): number | undefined {
  // Pattern 1: .status(N).json( — look backwards from .json
  // Check the ~200 chars before .json for .status(NNN) (generous window for chained calls)
  const lookbackStart = Math.max(0, jsonMatchPos - 200);
  const before = content.slice(lookbackStart, jsonMatchPos);
  const statusChainMatch = before.match(/\.status\s*\(\s*(\d{3})\s*\)\s*$/);
  if (statusChainMatch) {
    return parseInt(statusChainMatch[1], 10);
  }

  // Pattern 2: .json({...}, { status: N }) — look after closing brace for second arg
  if (closingBracePos > 0) {
    // After the first arg's closing brace, look for ", { status: N" within ~100 chars
    const afterFirstArg = content.slice(closingBracePos + 1, closingBracePos + 150);
    const secondArgMatch = afterFirstArg.match(/^\s*,\s*\{[^}]*status\s*:\s*(\d{3})/);
    if (secondArgMatch) {
      return parseInt(secondArgMatch[1], 10);
    }
  }

  // Pattern 3: new Response(JSON.stringify({...}), { status: N }) — look before .json for JSON.stringify
  // This is a less common pattern; we check if the .json is actually part of JSON.stringify
  // by looking for "new Response" further back
  const extendedBefore = content.slice(Math.max(0, jsonMatchPos - 300), jsonMatchPos);
  if (/new\s+Response\s*\(\s*JSON\s*\.stringify\s*$/.test(extendedBefore) && closingBracePos > 0) {
    // Look for ), { status: N }) after the stringify's closing paren
    const afterStringify = content.slice(closingBracePos + 1, closingBracePos + 200);
    const respStatusMatch = afterStringify.match(/^\s*\)\s*,\s*\{[^}]*status\s*:\s*(\d{3})/);
    if (respStatusMatch) {
      return parseInt(respStatusMatch[1], 10);
    }
  }

  return undefined;
}

/**
 * Extract response shapes from handler file content.
 * Finds all .json({...}) calls, extracts top-level keys using brace-depth counting,
 * and classifies into success (responseKeys) vs error (errorKeys) by HTTP status code.
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
      if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
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
  return {
    ...(successKeys.length > 0 ? { responseKeys: [...new Set(successKeys)] } : {}),
    ...(errKeys.length > 0 ? { errorKeys: [...new Set(errKeys)] } : {}),
  };
}
