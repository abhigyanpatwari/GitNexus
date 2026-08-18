import type { CaptureMatch, ParsedImport, ParsedTypeBinding, TypeRef } from 'gitnexus-shared';

const stripQuotes = (s: string): string => s.replace(/^["']|["']$/g, '');

/**
 * `const std = @import("std");` binds the imported module to a const handle
 * accessed via qualified syntax — a namespace import (closest peers: Python
 * `import numpy`, Go `import "pkg/bar"`). The local name and imported name
 * are always the same identifier; Zig has no rename syntax at the import
 * site (renames are ordinary const aliases handled as variable bindings).
 */
export function interpretZigImport(captures: CaptureMatch): ParsedImport | null {
  const name = captures['@import.name']?.text;
  const source = captures['@import.source']?.text;
  if (name === undefined || source === undefined) return null;
  const targetRaw = stripQuotes(source);
  if (targetRaw.length === 0) return null;
  return { kind: 'namespace', localName: name, importedName: name, targetRaw };
}

/**
 * Strip Zig type sigils that wrap the nominal type: pointers (`*T`, `[*]T`),
 * optionals (`?T`), error unions (`!T` / `E!T`), slices (`[]T`), arrays
 * (`[N]T`), and `const` qualifiers. Keeps the bare type name so registry
 * lookup matches the container declaration.
 */
export function normalizeZigTypeName(text: string): string {
  let t = text.trim();
  let previous: string;
  do {
    previous = t;
    t = t.replace(/^(\*|\?|\[\*?c?\]|\[[^\]]*\])\s*/, '');
    t = t.replace(/^const\s+/, '');
  } while (t !== previous);
  const bang = t.lastIndexOf('!');
  if (bang !== -1) t = t.slice(bang + 1).trim();
  return t;
}

export function interpretZigTypeBinding(captures: CaptureMatch): ParsedTypeBinding | null {
  const name = captures['@type-binding.name']?.text;
  const type = captures['@type-binding.type']?.text;
  if (name === undefined || type === undefined) return null;

  let source: TypeRef['source'] = 'annotation';
  if (captures['@type-binding.parameter'] !== undefined) {
    // Zig has no implicit receiver keyword; the convention is a FIRST
    // parameter named `self`. `emitZigScopeCaptures` tags first-position
    // parameters; the name alone is not enough — `fn f(a: u32, self: T)` is
    // legal and `self` there is an ordinary parameter, not a receiver.
    const isReceiver = name === 'self' && captures['@type-binding.first-parameter'] !== undefined;
    source = isReceiver ? 'self' : 'parameter-annotation';
  } else if (captures['@type-binding.constructor'] !== undefined) {
    source = 'constructor-inferred';
  }

  return { boundName: name, rawTypeName: normalizeZigTypeName(type), source };
}
