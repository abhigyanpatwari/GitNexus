/**
 * Parse top-level generic/template arguments from a type-like string.
 *
 * Examples:
 * - `List<int>` -> ['int']
 * - `Map<string, vector<int>>` -> ['string', 'vector<int>']
 * - `List<T*>` -> ['T*']
 */
export function extractTemplateArguments(text: string): string[] | undefined {
  const start = text.indexOf('<');
  if (start === -1) return undefined;
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '<') depth += 1;
    else if (ch === '>') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
      if (depth < 0) return undefined;
    }
  }
  if (end === -1) return undefined;
  const inner = text.slice(start + 1, end);
  if (inner.trim().length === 0) return undefined;

  const args: string[] = [];
  let tokenStart = 0;
  let nested = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '<') nested += 1;
    else if (ch === '>') nested -= 1;
    else if (ch === ',' && nested === 0) {
      const token = inner.slice(tokenStart, i).replace(/\s+/g, '');
      if (token.length > 0) args.push(token);
      tokenStart = i + 1;
    }
  }
  const last = inner.slice(tokenStart).replace(/\s+/g, '');
  if (last.length > 0) args.push(last);
  return args.length > 0 ? args : undefined;
}

export function stripTemplateArguments(text: string): string {
  const start = text.indexOf('<');
  if (start === -1) return text;
  return text.slice(0, start);
}

export function templateArgumentsIdTag(templateArguments?: readonly string[]): string {
  if (templateArguments === undefined || templateArguments.length === 0) return '';
  return `~${templateArguments.join(',')}`;
}

/**
 * Stable short hash for the opaque `SymbolDefinition.templateConstraints`
 * payload (issue #1579). Two function-template overloads with identical
 * `parameterTypes` but mutually-exclusive SFINAE constraints
 * (`enable_if_t<is_integral_v<T>>` vs `enable_if_t<is_floating_point_v<T>>`)
 * must produce distinct graph node IDs so the constraint-filter step
 * has two candidates to narrow between. Without this they collapse to
 * a single Function node and the SFINAE golden case can only emit one
 * edge regardless of resolver fixes.
 *
 * FNV-1a 32-bit, base36 encoded. Deterministic; non-cryptographic — the
 * tag's job is collision-avoidance among same-name overloads in one
 * file, not security.
 */
export function constraintsHash(jsonText: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < jsonText.length; i++) {
    h ^= jsonText.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Build the `~c:<hash>` ID suffix from an opaque constraint payload.
 *  Returns empty string when the payload is absent so callers can
 *  string-concatenate unconditionally. */
export function templateConstraintsIdTag(payload: unknown): string {
  if (payload === undefined || payload === null) return '';
  return `~c:${constraintsHash(JSON.stringify(payload))}`;
}
