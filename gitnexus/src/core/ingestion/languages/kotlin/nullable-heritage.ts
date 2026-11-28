// Only nominal types can acquire an outer '?' without changing precedence.
// Tokenize escaped names whole so punctuation inside them stays part of the name.
const typeName = /`[^`\r\n]+`|[_\p{ID_Start}]\p{ID_Continue}*/u;
const typeToken = new RegExp(typeName.source + String.raw`|\S`, 'gu');
const nameStart = /^[_`\p{ID_Start}]/u;

function validNameToken(token: string, next: string, argument: boolean): boolean {
  if (token === '*') return argument && (next === '>' || next === ',');
  return nameStart.test(token) && token !== '`' && token !== 'in';
}

function validTypeSeparator(token: string, previous: string, depth: number): boolean {
  switch (token) {
    case '<':
      return previous !== '?' && previous !== '>';
    case '.':
      return previous !== '?';
    case ',':
    case '>':
      return depth > 0;
    case '?':
      return previous !== '?';
    default:
      return false;
  }
}

type NominalTypeState = { depth: number; needsName: boolean };

function consumeName(
  tokens: string[],
  i: number,
  previous: string,
  state: NominalTypeState,
): boolean {
  const token = tokens[i]!;
  const next = tokens[i + 1] ?? '';
  const argument = previous === '<' || previous === ',';
  // 'out' is also a legal name. It is a modifier only before an argument type.
  if (argument && (token === 'in' || token === 'out') && nameStart.test(next)) {
    tokens[i] = token + ' ';
    return true;
  }
  state.needsName = false;
  return validNameToken(token, next, argument);
}

function consumeSeparator(token: string, previous: string, state: NominalTypeState): boolean {
  if (!validTypeSeparator(token, previous, state.depth)) return false;
  if (token === '<') state.depth++;
  if (token === '>') state.depth--;
  state.needsName = token === '<' || token === '.' || token === ',';
  return true;
}

export function kotlinNominalType(spelling: string): string | null {
  const state = { depth: 0, needsName: true };
  const tokens = Array.from(spelling.matchAll(typeToken), ([token]) => token);
  let previous = '';
  for (const [i, token] of tokens.entries()) {
    const valid = state.needsName
      ? consumeName(tokens, i, previous, state)
      : consumeSeparator(token, previous, state);
    if (!valid) return null;
    previous = token;
  }
  return state.needsName || state.depth !== 0 ? null : tokens.join('');
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
