/**
 * Lua import interpretation (RFC #909).
 *
 * `require("a.b.c")` loads the module and (conventionally) returns its table.
 * We emit a `wildcard` ParsedImport so the IMPORTS edge (this file → required
 * file) is materialized and the target's exported names become resolvable as
 * the module's local name. Call-target linking for `util.split` style member
 * calls is handled by the scope-resolution registry against the import
 * binding — refined in Phase B3 (receiver/arity polish).
 */
import type { CaptureMatch, ParsedImport } from 'gitnexus-shared';

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

export function interpretLuaImport(captures: CaptureMatch): ParsedImport | null {
  const source = captures['@import.source']?.text;
  if (source === undefined) return null;
  const targetRaw = stripQuotes(source);
  if (!targetRaw) return null;
  return { kind: 'wildcard', targetRaw };
}
