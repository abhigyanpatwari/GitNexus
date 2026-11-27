// Only nominal types can acquire an outer '?' without changing precedence.
// Tokenize escaped names whole so punctuation inside them stays part of the name.
const typeToken = /`[^`\r\n]+`|[_\p{ID_Start}][\p{ID_Continue}]*|[^\s]/gu;
const nameStart = /^[_`\p{ID_Start}]/u;

export function kotlinNominalType(spelling: string): string | null {
  let depth = 0;
  let needsName = true;
  let previous = '';
  const tokens: string[] = [];
  for (const [token] of spelling.matchAll(typeToken)) {
    if (needsName) {
      if (!nameStart.test(token) || token === '`') return null;
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
    tokens.push(token);
    previous = token;
  }
  return needsName || depth !== 0 ? null : tokens.join('');
}
