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
  const source = captures['@import.source']?.text;
  if (source === undefined) return null;
  const targetRaw = stripQuotes(source);
  if (targetRaw.length === 0) return null;

  // `pub usingnamespace @import("x.zig");` — every pub decl of the target
  // becomes a decl of this container. A wildcard, expanded by
  // `expandZigWildcardNames` in the scope resolver.
  if (captures['@import.wildcard'] !== undefined) {
    return { kind: 'wildcard', targetRaw };
  }

  const name = captures['@import.name']?.text;
  if (name === undefined) return null;

  // `const Foo = @import("x.zig").Foo;` — one member, under a name of the
  // importer's choosing (a rename when it differs: `const Alloc =
  // @import("std").mem;`). Same fact as TS `import { Foo } from './x'` /
  // `import { Foo as Bar }`.
  const imported = captures['@import.imported']?.text;
  if (imported !== undefined) {
    return imported === name
      ? { kind: 'named', localName: name, importedName: imported, targetRaw }
      : { kind: 'alias', localName: name, importedName: imported, alias: name, targetRaw };
  }

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
  // Generic instantiation `List(u8)` / `std.ArrayList(u8)` → the type
  // constructor `List` / `std.ArrayList`: Zig spells a generic type as a
  // call, and the container def is registered under the function's name.
  // Builtins (`@This()`, `@TypeOf(x)`) keep their parentheses — they are
  // not constructor names and must not turn into `@This`.
  if (!t.startsWith('@')) {
    const paren = t.indexOf('(');
    if (paren > 0 && t.endsWith(')')) t = t.slice(0, paren).trim();
  }
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
  } else if (captures['@type-binding.call-return'] !== undefined) {
    // `var c = Counter.init();` — the call's receiver names the type when it
    // is a container (`Counter`, `mod.Counter`, `List(u8)`); a value receiver
    // (`std.mem`, `self.items`) simply finds no container and declines.
    source = 'constructor-inferred';
  } else if (captures['@type-binding.annotation'] !== undefined) {
    // `var x: T = undefined;` / `const x: T = .init(…);` — the declared type.
    source = 'annotation';
  }

  return { boundName: name, rawTypeName: normalizeZigTypeName(type), source };
}
