/**
 * Oracle identifier normalisation, kept free of the ANTLR runtime so the
 * provider, resolver and rename modules can use it without loading the parser.
 */

/** Unquoted identifiers are upper-case; quoted identifiers keep their spelling without quotes. */
export function normaliseIdentifier(text: string): string {
  return text.startsWith('"') && text.endsWith('"') && text.length >= 2
    ? text.slice(1, -1)
    : text.toUpperCase();
}
