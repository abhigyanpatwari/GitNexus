import type { SyntaxNode } from 'tree-sitter';

/**
 * Framework import paths, matched EXACTLY on both layers (ingestion's
 * `go-gin-echo.ts` and the group-mode `http-patterns/go.ts`): a substring
 * test would classify `example.com/labstack/echo-wrapper` as echo on one
 * side only, flipping the handler-argument order and splitting contracts.
 */
export function isGinImportPath(importPath: string): boolean {
  return importPath === 'github.com/gin-gonic/gin';
}

export function isEchoImportPath(importPath: string): boolean {
  return /^github\.com\/labstack\/echo(\/v\d+)?$/.test(importPath);
}

/**
 * Go string-literal decoding shared by the Go route extractors on both
 * layers: the ingestion extractor (`go-gin-echo.ts`, Strategy A) and the
 * group-mode HTTP plugin (`group/extractors/http-patterns/go.ts`,
 * Strategy B). Both sides must produce the SAME text for a route literal,
 * or the same route lands under two different contract ids that never
 * collide in the merge — a wrong-path duplicate that survives alongside
 * the graph's correct entry.
 *
 * Go's semantics, per `strconv.Unquote`:
 *   - interpreted (`"…"`) strings decode escapes (`\n`, `\x2f`, `ሴ`,
 *     `\101`, …); hex and octal escapes encode BYTES, not code points;
 *   - raw (`` `…` ``) strings have no escapes (a backslash is literal),
 *     and Go discards carriage returns in them, including CRLF source files;
 *   - a string that cannot be decoded to valid UTF-8 text (invalid escape,
 *     non-UTF-8 bytes) returns null — callers decline instead of guessing,
 *     since a URL cannot carry those bytes losslessly.
 *
 * Nodes that are not string literals (an identifier prefix, a rune
 * literal, an errored subtree) also return null.
 */
export function stringLiteral(node: SyntaxNode | null | undefined): string | null {
  if (!node || node.hasError) return null;
  const body = node.text.slice(1, -1);
  // Go discards carriage returns in raw strings, including CRLF source files.
  if (node.type === 'raw_string_literal') return body.replace(/\r/g, '');
  if (node.type !== 'interpreted_string_literal') return null;
  if (!body.includes('\\')) return body;

  const simple: Readonly<Record<string, string>> = {
    a: '\x07',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    '\\': '\\',
    '"': '"',
  };
  const chunks: Buffer[] = [];
  const tokens =
    /\\(?:[abfnrtv\\"]|[0-7]{3}|x[\da-fA-F]{2}|u[\da-fA-F]{4}|U[\da-fA-F]{8})|[^\\"\n]+/g;
  let consumed = 0;
  for (const match of body.matchAll(tokens)) {
    if (match.index !== consumed) return null;
    const token = match[0];
    consumed += token.length;
    if (!token.startsWith('\\')) {
      chunks.push(Buffer.from(token));
    } else if (simple[token[1]] !== undefined) {
      chunks.push(Buffer.from(simple[token[1]]));
    } else {
      const octal = /[0-7]/.test(token[1]);
      const value = Number.parseInt(token.slice(octal ? 1 : 2), octal ? 8 : 16);
      if (octal || token[1] === 'x') {
        // Octal and hex escapes encode bytes, not Unicode code points.
        if (value > 255) return null;
        chunks.push(Buffer.from([value]));
      } else {
        if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return null;
        chunks.push(Buffer.from(String.fromCodePoint(value)));
      }
    }
  }
  if (consumed !== body.length) return null;
  try {
    // Arbitrary non-UTF-8 Go byte strings cannot be represented losslessly in a URL.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  } catch {
    return null;
  }
}
