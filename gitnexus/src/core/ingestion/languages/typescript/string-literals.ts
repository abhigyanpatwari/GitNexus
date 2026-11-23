const SIMPLE_STRING_ESCAPES: Readonly<Record<string, string>> = {
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
};

export function decodeJavaScriptStringLiteral(raw: string): string | null {
  if (raw.length < 2) return null;
  const delimiter = raw[0];
  if (
    (delimiter !== "'" && delimiter !== '"' && delimiter !== '`') ||
    raw[raw.length - 1] !== delimiter
  ) {
    return null;
  }

  const body = raw.slice(1, -1);
  let decoded = '';
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char !== '\\') {
      if (delimiter !== '`' && (char === '\n' || char === '\r')) return null;
      decoded += char;
      continue;
    }

    const escaped = body[++index];
    if (escaped === undefined) return null;
    if (escaped === '\n' || escaped === '\u2028' || escaped === '\u2029') continue;
    if (escaped === '\r') {
      if (body[index + 1] === '\n') index++;
      continue;
    }

    const simple = SIMPLE_STRING_ESCAPES[escaped];
    if (simple !== undefined) {
      decoded += simple;
      continue;
    }
    if (escaped === '0') {
      if (/\d/.test(body[index + 1] ?? '')) return null;
      decoded += '\0';
      continue;
    }
    if (/[1-9]/.test(escaped)) return null;
    if (escaped === 'x') {
      const hex = body.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
      decoded += String.fromCharCode(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    if (escaped === 'u') {
      if (body[index + 1] === '{') {
        const close = body.indexOf('}', index + 2);
        if (close === -1) return null;
        const hex = body.slice(index + 2, close);
        if (!/^[0-9A-Fa-f]{1,6}$/.test(hex)) return null;
        const codePoint = Number.parseInt(hex, 16);
        if (codePoint > 0x10ffff) return null;
        decoded += String.fromCodePoint(codePoint);
        index = close;
        continue;
      }
      const hex = body.slice(index + 1, index + 5);
      if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return null;
      decoded += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
      continue;
    }

    // JavaScript treats an escaped non-special character as that character.
    decoded += escaped;
  }
  return decoded;
}
