/**
 * Capture-match → semantic-shape interpreters for C#.
 *
 *   - `interpretCsharpImport`     → `ParsedImport`
 *   - `interpretCsharpTypeBinding` → `ParsedTypeBinding`
 *
 * The using-directive matches arrive pre-decomposed by
 * `emitCsharpScopeCaptures` (one import per match, with synthesized
 * `@import.kind/source/name/alias` markers). Type-binding matches arrive
 * from the raw query captures — each `@type-binding.*` anchor carries
 * `@type-binding.name` + `@type-binding.type`.
 */

import type { CaptureMatch, ParsedImport, ParsedTypeBinding, TypeRef } from 'gitnexus-shared';

// ─── interpretImport ──────────────────────────────────────────────────────

export function interpretCsharpImport(captures: CaptureMatch): ParsedImport | null {
  const kindCap = captures['@import.kind'];
  const sourceCap = captures['@import.source'];
  const nameCap = captures['@import.name'];
  const aliasCap = captures['@import.alias'];

  const kind = kindCap?.text;
  if (kind === undefined || sourceCap === undefined) return null;

  switch (kind) {
    case 'namespace': {
      // `using System;` / `using System.Collections.Generic;`
      // Bind the last segment as the local name so `Generic.Foo`-style
      // qualifier references resolve. Full path is the resolution target.
      return {
        kind: 'namespace',
        localName: nameCap?.text ?? sourceCap.text.split('.').pop() ?? sourceCap.text,
        importedName: sourceCap.text,
        targetRaw: sourceCap.text,
      };
    }
    case 'alias': {
      // `using Dict = System.Collections.Generic.Dictionary<string, int>;`
      // The decomposer already stripped generic args from source.
      if (aliasCap === undefined) return null;
      const importedName = sourceCap.text.split('.').pop() ?? sourceCap.text;
      return {
        kind: 'alias',
        localName: aliasCap.text,
        importedName,
        alias: aliasCap.text,
        targetRaw: sourceCap.text,
      };
    }
    case 'static': {
      // `using static System.Math;` — brings static members of Math into
      // unqualified scope. Semantically closest to a wildcard: any name
      // can resolve to a static member of the target type. Merge-bindings
      // (Unit 4) ranks wildcards lowest so locals still shadow.
      return { kind: 'wildcard', targetRaw: sourceCap.text };
    }
    default:
      return null;
  }
}

// ─── interpretTypeBinding ─────────────────────────────────────────────────

export function interpretCsharpTypeBinding(captures: CaptureMatch): ParsedTypeBinding | null {
  const nameCap = captures['@type-binding.name'];
  const typeCap = captures['@type-binding.type'];
  if (nameCap === undefined || typeCap === undefined) return null;

  // Strip nullable suffix (`User?` → `User`), single-arg generic wrapper
  // (`List<User>` → `User`), and qualifier (`System.User` → `User`) so
  // receiver-typed resolution treats these identically.
  const rawType = stripQualifier(stripGeneric(stripNullable(typeCap.text.trim())));

  // Anchor captures distinguish the source of the binding. Order
  // matters: more-specific anchors take precedence.
  let source: TypeRef['source'] = 'parameter-annotation';
  if (captures['@type-binding.self'] !== undefined) source = 'self';
  else if (captures['@type-binding.constructor'] !== undefined) source = 'constructor-inferred';
  else if (captures['@type-binding.annotation'] !== undefined) source = 'annotation';
  else if (captures['@type-binding.alias'] !== undefined) source = 'assignment-inferred';
  else if (captures['@type-binding.return'] !== undefined) source = 'return-annotation';

  return { boundName: nameCap.text, rawTypeName: rawType, source };
}

/** `User?` → `User`. */
function stripNullable(text: string): string {
  if (text.endsWith('?')) return text.slice(0, -1).trim();
  return text;
}

/**
 * Unwrap a single-arg generic collection wrapper — `List<User>`,
 * `IEnumerable<User>`, `Task<User>` — to its element type. Mirrors
 * Python's `stripGeneric` behavior so for-loop and chain propagation
 * work on the element type.
 *
 * Multi-arg generics (`Dictionary<string, User>`, `Func<int, User>`)
 * are left alone — element semantics aren't unambiguous.
 */
function stripGeneric(text: string): string {
  const single = text.match(
    /^(?:[A-Za-z_][A-Za-z0-9_.]*\.)?(?:List|IList|IEnumerable|ICollection|IReadOnlyList|IReadOnlyCollection|HashSet|ISet|Task|ValueTask|Nullable|IAsyncEnumerable)<([^,<>]+)>$/,
  );
  if (single !== null) return single[1].trim();
  return text;
}

/** `System.Collections.User` → `User`. */
function stripQualifier(text: string): string {
  const lastDot = text.lastIndexOf('.');
  if (lastDot === -1) return text;
  return text.slice(lastDot + 1);
}
