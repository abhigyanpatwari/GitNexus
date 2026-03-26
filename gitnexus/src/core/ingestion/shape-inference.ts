/**
 * AST-based shape inference utilities.
 *
 * Extracts data shape information from source code using regex patterns
 * (not tree-sitter — these run on raw text for flexibility across contexts).
 */

/** Keys that are method-like and should be filtered from property access results */
const ACCESS_BLOCKLIST = new Set([
  'length', 'toString', 'valueOf', 'hasOwnProperty', 'constructor',
  'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'map', 'filter',
  'reduce', 'forEach', 'find', 'findIndex', 'includes', 'indexOf',
  'keys', 'values', 'entries', 'then', 'catch', 'finally',
  'json', 'text', 'blob', 'arrayBuffer', 'formData', 'clone', 'ok', 'status',
  // DOM API noise
  'appendChild', 'removeChild', 'insertBefore', 'replaceChild', 'querySelector',
  'querySelectorAll', 'getAttribute', 'setAttribute', 'addEventListener',
  'removeEventListener', 'classList', 'style', 'className', 'innerHTML',
  'textContent', 'parentNode', 'childNodes', 'firstChild', 'lastChild',
  'nextSibling', 'previousSibling', 'nodeName', 'nodeType', 'ownerDocument',
]);

/**
 * Extract top-level keys from object literals in .json() or return statements.
 * Uses brace-depth counting (same approach as response-shapes.ts).
 */
export function extractObjectLiteralKeys(code: string): string[] {
  const keys: string[] = [];
  const jsonPattern = /\.json\s*\(\s*\{|return\s+\{/g;
  let match: RegExpExecArray | null;

  while ((match = jsonPattern.exec(code)) !== null) {
    const braceStart = code.indexOf('{', match.index);
    if (braceStart === -1) continue;

    let depth = 0;
    let keyStart = -1;
    for (let i = braceStart; i < code.length; i++) {
      const ch = code[i];
      if (ch === '{') {
        depth++;
        if (depth === 1) keyStart = i + 1;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          // Check for trailing shorthand before closing brace
          const segment = code.slice(keyStart, i).trim();
          if (segment && /^\w+$/.test(segment)) {
            keys.push(segment);
          }
          break;
        }
      } else if (depth === 1 && ch === ':') {
        const beforeColon = code.slice(keyStart, i).trim();
        const keyMatch = beforeColon.match(/(?:['"]([^'"]+)['"]|(\w+))\s*$/);
        if (keyMatch) {
          keys.push(keyMatch[1] || keyMatch[2]);
        }
      } else if (depth === 1 && ch === ',') {
        // Shorthand property: { patterns, total }
        const segment = code.slice(keyStart, i).trim();
        if (segment && /^\w+$/.test(segment)) {
          keys.push(segment);
        }
        keyStart = i + 1;
      }
    }
  }

  return [...new Set(keys)];
}

/**
 * Extract destructured keys from variable declarations.
 * Matches: const { key1, key2 } = data/response/result/res.json()
 * Handles nested braces by brace-depth counting to find the outermost block.
 */
export function extractDestructuredKeys(code: string): string[] {
  const keys: string[] = [];
  const startPattern = /const\s+\{/g;
  let match: RegExpExecArray | null;

  while ((match = startPattern.exec(code)) !== null) {
    const braceStart = code.indexOf('{', match.index);
    if (braceStart === -1) continue;

    // Collect the content of the outermost braces using depth counting
    let depth = 0;
    let innerStart = braceStart + 1;
    let innerEnd = -1;
    for (let i = braceStart; i < code.length; i++) {
      const ch = code[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          innerEnd = i;
          break;
        }
      }
    }
    if (innerEnd === -1) continue;

    const inner = code.slice(innerStart, innerEnd);

    // Split by top-level commas (ignoring commas inside nested braces)
    const parts: string[] = [];
    let partStart = 0;
    let d = 0;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === '{') d++;
      else if (ch === '}') d--;
      else if (ch === ',' && d === 0) {
        parts.push(inner.slice(partStart, i));
        partStart = i + 1;
      }
    }
    parts.push(inner.slice(partStart));

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const keyMatch = trimmed.match(/^(\w+)/);
      if (keyMatch && keyMatch[1] !== 'rest') {
        keys.push(keyMatch[1]);
      }
    }
  }

  return [...new Set(keys)];
}

/**
 * Extract property access keys from dot-access and optional chaining patterns.
 * Matches: data.key, response?.key, result.key
 * Also matches second-level access: result.data?.key, response.data.key
 */
export function extractPropertyAccessKeys(code: string): string[] {
  const keys: string[] = [];
  const dataVarNames = /(?:data|response|result|res|json|payload|body|state|value)/;
  // Level-1: data.key or data?.key
  const pattern = new RegExp(
    `(?:${dataVarNames.source})\\??\\.([a-zA-Z_]\\w*)`,
    'g',
  );
  // Level-2: result.data?.key or result.data.key (data-var followed by .word?.key)
  const pattern2 = new RegExp(
    `(?:${dataVarNames.source})\\??\\.\\w+\\??\\.([a-zA-Z_]\\w*)`,
    'g',
  );
  let match: RegExpExecArray | null;

  for (const pat of [pattern, pattern2]) {
    while ((match = pat.exec(code)) !== null) {
      const key = match[1];
      if (!ACCESS_BLOCKLIST.has(key)) {
        keys.push(key);
      }
    }
  }

  return [...new Set(keys)];
}

/**
 * Extract static prefix from a cache key expression.
 */
export function cacheKeyPrefix(cacheKey: string): string {
  const arrayMatch = cacheKey.match(/\[\s*['"]([^'"]+)['"]/);
  if (arrayMatch) return arrayMatch[1];

  const stringMatch = cacheKey.match(/^['"]([^'"]+)['"]/);
  if (stringMatch) return stringMatch[1];

  const templateMatch = cacheKey.match(/^`([^$`]+)/);
  if (templateMatch) return templateMatch[1];

  return cacheKey;
}

/**
 * Check if two cache keys potentially overlap (could point to same slot).
 * Uses prefix matching — if static prefixes match, keys might collide.
 */
export function cacheKeysOverlap(key1: string, key2: string): boolean {
  const prefix1 = cacheKeyPrefix(key1);
  const prefix2 = cacheKeyPrefix(key2);
  return prefix1 === prefix2 && prefix1.length > 0;
}
