/**
 * Lua import interpretation (RFC #909).
 *
 * `require("a.b.c")` loads the module and (conventionally) returns its table.
 * Two forms:
 *   - `local X = require("a.b.c")`: emits a `namespace` ParsedImport so the
 *     IMPORTS edge materializes AND `X.foo()` member calls resolve across files
 *     (collectNamespaceTargets registers `X → target file`; Case 1 of the
 *     receiver-bound-calls pass links `X.foo()` to the target's `foo`).
 *   - bare `require("a.b.c")` (side-effect, no binding): emits `wildcard`; the
 *     IMPORTS edge materializes but no receiver is bound.
 *
 * `importedName` is the last dot-segment of the module path (e.g. `util` for
 * `lib.util`) — used by finalize to bind the target's self-named export when
 * present; harmless when the module returns an unnamed table.
 *
 * Receiver/arity precision beyond the namespace-receiver path (e.g. resolving
 * `local f = M.answer; f()`) remains Phase B3.
 */
import type { CaptureMatch, ParsedImport } from 'gitnexus-shared';

function stripLuaString(s: string): string {
  const long = s.match(/^\[(=*)\[([\s\S]*)\]\1\]$/);
  return long ? long[2] : stripQuotes(s);
}

function stripQuotes(s: string): string {
  const quoted = s.match(/^(?:(["'])([\s\S]*)\1|\[(=*)\]([\s\S]*)\]\3\])$/);
  if (!quoted) return s;
  return quoted[2] ?? quoted[4] ?? '';
}

export function interpretLuaImport(captures: CaptureMatch): ParsedImport | null {
  const source = captures['@import.source']?.text;
  if (source === undefined) return null;
  const targetRaw = stripLuaString(source);
  if (!targetRaw) return null;
  const localName = captures['@import.localName']?.text;
  if (localName) {
    const segments = targetRaw.split('.').filter(Boolean);
    const importedName = segments[segments.length - 1] ?? localName;
    return { kind: 'namespace', localName, importedName, targetRaw };
  }
  return { kind: 'wildcard', targetRaw };
}
