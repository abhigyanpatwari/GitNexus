// Only nominal types can acquire an outer '?' without changing precedence.
// Tokenize escaped names whole so punctuation inside them stays part of the name.
const typeName = /`[^`\r\n]+`|[_\p{ID_Start}][\p{ID_Continue}]*/u;
const typeToken = new RegExp(typeName.source + String.raw`|[^\s]`, 'gu');
const nameStart = /^[_`\p{ID_Start}]/u;

export function kotlinNominalType(spelling: string): string | null {
  let depth = 0;
  let needsName = true;
  let previous = '';
  const tokens = spelling.match(typeToken) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const next = tokens[i + 1] ?? '';
    if (needsName) {
      const argument = previous === '<' || previous === ',';
      // 'out' is also a legal name. It is a modifier only before an argument type.
      if (argument && (token === 'in' || token === 'out') && nameStart.test(next)) {
        tokens[i] = token + ' ';
        previous = token;
        continue;
      }
      if (token === '*') {
        if (!argument || (next !== '>' && next !== ',')) return null;
      } else if (!nameStart.test(token) || token === '`' || token === 'in') {
        return null;
      }
      needsName = false;
    } else if (token === '<') {
      if (previous === '?' || previous === '>') return null;
      depth++;
      needsName = true;
    } else if (token === '.' || token === ',') {
      if (token === '.' ? previous === '?' : depth === 0) return null;
      needsName = true;
    } else if (token === '>') {
      if (depth === 0) return null;
      depth--;
    } else if (token !== '?' || previous === '?') {
      return null;
    }
    previous = token;
  }
  return needsName || depth !== 0 ? null : tokens.join('');
}

// Match entire qualified or escaped names. Skip in/out projections followed by their type.
const namePart = `(?:${typeName.source})`;
const nullableNames = new RegExp(
  String.raw`(?<![\p{ID_Continue}])(?!(?:in|out)\s+(?=${namePart}))${namePart}(?:\s*\.\s*${namePart})*(?:\s*\?)?`,
  'gu',
);

/** Only substitute inside a type whose nominal structure this provider can validate. */
export function kotlinNullableTypePattern(type: string): RegExp | undefined {
  return type.includes('?') && kotlinNominalType(type) !== null ? nullableNames : undefined;
}
