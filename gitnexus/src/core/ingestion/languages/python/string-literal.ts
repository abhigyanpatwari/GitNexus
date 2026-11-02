import type Parser from 'tree-sitter';

/** Decode only source-proven strings; interpolation and named escapes stay unknown. */
export function pythonStringLiteral(node: Parser.SyntaxNode): string | undefined {
  if (node.hasError) return undefined;
  if (node.type === 'concatenated_string') {
    let value = '';
    for (const child of node.namedChildren) {
      if (child.type === 'comment') continue;
      const part = pythonStringLiteral(child);
      if (part === undefined) return undefined;
      value += part;
    }
    return value;
  }
  if (node.type !== 'string') return undefined;
  const start = /^([ru]?)("""|'''|"|')/i.exec(node.text);
  const delimiter = start?.[2];
  if (!start || !delimiter || !node.text.endsWith(delimiter)) return undefined;
  const body = node.text.slice(start[0].length, -delimiter.length);
  if (start[1]?.toLowerCase() === 'r') return body;
  const escapes: Readonly<Record<string, string>> = {
    '\\': '\\',
    "'": "'",
    '"': '"',
    a: '\x07',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
  };
  let value = '';
  for (let cursor = 0; cursor < body.length; cursor++) {
    const token = body.charAt(cursor);
    if (token !== '\\') {
      value += token;
      continue;
    }
    const escape = body[++cursor];
    if (escape === undefined) return undefined;
    if (escape === '\n') continue;
    if (escape === '\r') {
      if (body[cursor + 1] === '\n') cursor++;
      continue;
    }
    if (escapes[escape] !== undefined) {
      value += escapes[escape];
      continue;
    }
    if (/[0-7]/.test(escape)) {
      const digits = /^[0-7]{1,3}/.exec(body.slice(cursor))?.[0];
      if (!digits) return undefined;
      value += String.fromCodePoint(Number.parseInt(digits, 8));
      cursor += digits.length - 1;
      continue;
    }
    const width = escape === 'x' ? 2 : escape === 'u' ? 4 : escape === 'U' ? 8 : undefined;
    if (width === undefined) return undefined;
    const digits = body.slice(cursor + 1, cursor + 1 + width);
    if (digits.length !== width || !/^[\da-f]+$/i.test(digits)) return undefined;
    const point = Number.parseInt(digits, 16);
    if (point > 0x10ffff) return undefined;
    value += String.fromCodePoint(point);
    cursor += width;
  }
  return value;
}
