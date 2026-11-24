const SIMPLE_STRING_ESCAPES: Readonly<Record<string, string>> = {
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
};

interface DecodedEscape {
  value: string;
  end: number;
}

function hexEscape(body: string, start: number, width: number): DecodedEscape | null {
  const hex = body.slice(start, start + width);
  if (hex.length !== width || /[^0-9a-f]/i.test(hex)) return null;
  return { value: String.fromCodePoint(Number.parseInt(hex, 16)), end: start + width };
}

function unicodeEscape(body: string, start: number): DecodedEscape | null {
  if (body[start] !== '{') return hexEscape(body, start, 4);
  const end = body.indexOf('}', start + 1);
  if (end === -1 || end === start + 1) return null;
  const hex = body.slice(start + 1, end);
  if (/[^0-9a-f]/i.test(hex)) return null;
  const codePoint = Number.parseInt(hex, 16);
  if (codePoint > 0x10ffff) return null;
  return { value: String.fromCodePoint(codePoint), end: end + 1 };
}

function readEscape(body: string, start: number): DecodedEscape | null {
  const escaped = body[start];
  const end = start + 1;
  switch (escaped) {
    case undefined:
      return null;
    case '\r':
      return { value: '', end: body[end] === '\n' ? end + 1 : end };
    case '\n':
    case '\u2028':
    case '\u2029':
      return { value: '', end };
    case 'x':
      return hexEscape(body, end, 2);
    case 'u':
      return unicodeEscape(body, end);
    case '0':
      return /\d/.test(body[end] ?? '') ? null : { value: '\0', end };
    default:
      if (/[1-9]/.test(escaped)) return null;
      return { value: SIMPLE_STRING_ESCAPES[escaped] ?? escaped, end };
  }
}

export function decodeStringLiteral(raw: string): string | null {
  const delimiter = raw[0];
  if (raw.length < 2 || !['"', "'", '`'].includes(delimiter) || !raw.endsWith(delimiter)) {
    return null;
  }
  const body = raw.slice(1, -1);
  const special = /[\\\r\n]/g;
  let decoded = '';
  let start = 0;
  for (let match = special.exec(body); match !== null; match = special.exec(body)) {
    decoded += body.slice(start, match.index);
    if (match[0] === '\\') {
      const escape = readEscape(body, special.lastIndex);
      if (!escape) return null;
      decoded += escape.value;
      special.lastIndex = escape.end;
    } else {
      if (delimiter !== '`') return null;
      decoded += '\n';
      if (match[0] === '\r' && body[special.lastIndex] === '\n') special.lastIndex++;
    }
    start = special.lastIndex;
  }
  return decoded + body.slice(start);
}

/** Decode ECMAScript identifier escapes without changing written graph identities. */
export const decodeIdentifierEscapes = (name: string): string =>
  name.replace(
    /\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/g,
    (escape, braced: string | undefined, fixed: string | undefined) => {
      const value = Number.parseInt(braced ?? fixed ?? '', 16);
      return value <= 0x10ffff ? String.fromCodePoint(value) : escape;
    },
  );

/** Read a written ModuleExportName as its runtime key. */
export function canonicalModuleExportName(spelling: string): string | null {
  if (!spelling.startsWith('"') && !spelling.startsWith("'"))
    return decodeIdentifierEscapes(spelling);
  const decoded = decodeStringLiteral(spelling);
  return decoded === null || /[\uD800-\uDFFF]/u.test(decoded) ? null : decoded;
}
