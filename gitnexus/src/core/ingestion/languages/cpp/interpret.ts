import type { CaptureMatch, ParsedImport, ParsedTypeBinding, TypeRef } from 'gitnexus-shared';

/**
 * Interpret a C++ import capture into a ParsedImport.
 *
 * C++ has three import forms:
 *   1. #include "file.h"  → wildcard import (all symbols from header)
 *   2. using namespace X; → wildcard import (all symbols from namespace X)
 *   3. using X::name;     → named import (single symbol from namespace X)
 *
 * System headers (#include <...>) are not resolved to local files.
 */
export function interpretCppImport(captures: CaptureMatch): ParsedImport | null {
  const source = captures['@import.source']?.text;
  if (source === undefined) return null;

  // System headers are not resolved to local files
  if (captures['@import.system'] !== undefined) return null;

  const kind = captures['@import.kind']?.text;

  if (kind === 'named') {
    // using X::name — named import
    const importedName = captures['@import.name']?.text;
    if (importedName === undefined) return null;
    return { kind: 'named', targetRaw: source, localName: importedName, importedName };
  }

  // #include or using namespace — wildcard import
  return { kind: 'wildcard', targetRaw: source };
}

/**
 * Interpret a C++ type-binding capture into a ParsedTypeBinding.
 *
 * Source classification (strongest → weakest):
 *   - `'parameter-annotation'` — function parameter type
 *   - `'annotation'`          — explicit type declaration (`User user;`)
 *   - `'assignment-inferred'` — typed init (`User user = ...`)
 *   - `'constructor'`         — constructor call (`auto u = User(...)` / `User{}`)
 *   - `'return'`              — function return type
 *   - `'field'`               — class field type
 *   - `'alias'`               — `auto x = existingVar`
 */
export function interpretCppTypeBinding(captures: CaptureMatch): ParsedTypeBinding | null {
  const name = captures['@type-binding.name']?.text;
  const type = captures['@type-binding.type']?.text;
  if (name === undefined || type === undefined) return null;

  let source: TypeRef['source'] = 'annotation';

  if (captures['@type-binding.parameter'] !== undefined) {
    source = 'parameter-annotation';
  } else if (captures['@type-binding.constructor'] !== undefined) {
    source = 'constructor-inferred';
  } else if (captures['@type-binding.return'] !== undefined) {
    source = 'return-annotation';
  } else if (captures['@type-binding.field'] !== undefined) {
    // Field types are structurally equivalent to annotations — the type
    // is explicitly written, not inferred.
    source = 'annotation';
  } else if (captures['@type-binding.member-access'] !== undefined) {
    // auto addr = user.address — the type is inferred from the member access.
    // Synthesize a dotted rawName ("receiver.field") so compound-receiver
    // can resolve the chain: look up receiver's class, then field's type.
    const receiver = captures['@type-binding.member-access-receiver']?.text;
    if (receiver !== undefined) {
      return { boundName: name, rawTypeName: `${receiver}.${type}`, source: 'assignment-inferred' };
    }
    source = 'assignment-inferred';
  } else if (captures['@type-binding.alias'] !== undefined) {
    // auto alias = existingVar — the type is inferred from the RHS variable.
    source = 'assignment-inferred';
  } else if (captures['@type-binding.assignment'] !== undefined) {
    source = 'assignment-inferred';
  } else if (captures['@type-binding.annotation'] !== undefined) {
    source = 'annotation';
  }

  // A member field's type is captured AS WRITTEN, qualifier and all
  // (`ns::Repo<User>`), because the query matches the outer
  // `qualified_identifier` — one depth-agnostic pattern per declarator shape
  // instead of one per qualifier depth. The qualifier is dropped HERE; see the
  // "Field type, QUALIFIED" block in query.ts for why the qualified spelling
  // resolves to nothing and the tail resolves like the bare one.
  //
  // FIELDS ONLY. `@type-binding.parameter` and `@type-binding.assignment` also
  // capture qualified spellings (their patterns use `type: (_)`), and reducing
  // THOSE would newly bind every qualified local and parameter in the workspace
  // — a far wider change than the member-field miss this closes, and not one
  // anything here has measured.
  const effectiveType =
    captures['@type-binding.field'] === undefined ? type : cppQualifiedTail(type);
  // The reduced spelling is also the AS-WRITTEN one, and saying so is load
  // bearing. `collectTypeBindings` derives `TypeRef.declaredSpelling` from
  // `@type-binding.type` whenever that text differs from `rawTypeName`, and it
  // now does for every qualified member. `declaredSpelling` exists to keep a
  // CONTAINER distinguishable from a class of the same name after capture
  // reduced it; a qualifier is not a container — `ns::Address` and `Address`
  // have the identical member set — so recording one here would answer
  // "container, as written" for a plain member and hand `elementTypeOf` a
  // spelling it never sees for the bare form.
  const declaredSpelling =
    cppPointerSpelling(captures, effectiveType, name) ??
    (effectiveType === type ? undefined : effectiveType);
  return declaredSpelling === undefined
    ? { boundName: name, rawTypeName: normalizeCppTypeName(effectiveType), source }
    : {
        boundName: name,
        rawTypeName: normalizeCppTypeName(effectiveType),
        declaredSpelling,
        source,
      };
}

/**
 * The tail of a `::`-qualified type spelling — `a::b::Repo<User>` → `Repo<User>`,
 * `ns::Address` → `Address`, an unqualified spelling unchanged.
 *
 * Only TOP-LEVEL separators count, so a qualified TYPE ARGUMENT survives:
 * `std::vector<std::string>` reduces to `vector<std::string>`, not to `string`.
 * That is the same string the old per-depth rules produced by capturing the
 * inner node, so the reduction is textual where it used to be structural and
 * the result is identical for every depth they covered.
 */
function cppQualifiedTail(text: string): string {
  let angleDepth = 0;
  let lastSeparator = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '<') angleDepth++;
    else if (ch === '>') {
      if (angleDepth > 0) angleDepth--;
    } else if (angleDepth === 0 && ch === ':' && text[i + 1] === ':') {
      lastSeparator = i;
      i++;
    }
  }
  if (lastSeparator === -1) return text;
  const tail = text.slice(lastSeparator + 2).trim();
  // A spelling that ends in `::` has no tail to reduce to. Cannot arise from a
  // parsed `qualified_identifier`, but returning an empty type name would make
  // the binding claim a type of `""`, so the written spelling is kept instead.
  return tail.length === 0 ? text : tail;
}

/** Anchors whose capture spans a whole declaration, so the declarator — and
 *  with it the pointer — is inside the captured text. */
const CPP_WHOLE_DECLARATION_ANCHORS = [
  '@type-binding.parameter',
  '@type-binding.annotation',
  '@type-binding.assignment',
] as const;

const squeezeWhitespace = (text: string): string => text.replace(/\s+/g, '');

/**
 * `User* repos` — the written spelling, when tree-sitter-cpp hangs the pointer
 * off the DECLARATOR rather than the type.
 *
 * `@type-binding.type` is a bare `User` there, so the binding records `User` and
 * nothing downstream can tell `repos[0]` (pointer subscript, element `User`)
 * from `grid[0]` on a class with `operator[]` (element: whatever the operator
 * returns). The index step needs that distinction and declines without it, so
 * the pointer is reconstructed here — at the capture layer, from the anchor,
 * which spans the whole declaration.
 *
 * EXACT SHAPE ONLY: the declaration must be precisely `<type> * <name>` once
 * whitespace is removed. `const T*`, `T**`, an array declarator, a reference,
 * a function pointer — none match, and none get a spelling, so the index step
 * declines for them. A loose match would hand back container evidence that is
 * not there and re-mint the confidently wrong edge this exists to prevent.
 */
function cppPointerSpelling(
  captures: CaptureMatch,
  typeText: string,
  nameText: string,
): string | undefined {
  // The target below always contains a literal `*`, so an anchor whose text has
  // none can never equal it. Testing that FIRST is the whole optimisation: this
  // runs on every C++ type binding and the overwhelming majority declare no
  // pointer, so the squeezes (three `replace` passes over the declaration, the
  // type and the name) are skipped entirely for them. `target` is built lazily
  // on the first star-bearing anchor for the same reason.
  let target: string | undefined;
  for (const anchor of CPP_WHOLE_DECLARATION_ANCHORS) {
    const text = captures[anchor]?.text;
    if (text === undefined || !text.includes('*')) continue;
    if (target === undefined) {
      const type = squeezeWhitespace(typeText);
      const name = squeezeWhitespace(nameText);
      if (type.length === 0 || name.length === 0) return undefined;
      target = `${type}*${name}`;
    }
    if (squeezeWhitespace(text) === target) return `${typeText.trim()}*`;
  }
  return undefined;
}

/** Declaration specifiers that carry no type identity. Held in ONE place so
 *  every consumer agrees on the keyword list — the resolver's element-type
 *  hook strips exactly the same set before deciding whether a spelling is a
 *  pointer, and a silently diverging copy there would make the two disagree
 *  about what `const T*` is. */
const CPP_SPECIFIER_RE =
  /\b(const|volatile|restrict|static|extern|inline|mutable|constexpr|consteval)\b/g;

/** Remove C++ declaration specifiers from `text` and trim the result. */
export function stripCppSpecifiers(text: string): string {
  return text.replace(CPP_SPECIFIER_RE, '').trim();
}

/**
 * Normalize a C++ type name: strip pointer/array/reference syntax,
 * qualifiers, while preserving template arguments for specialization-aware
 * receiver binding (`List<User>` vs `List<Order>`).
 *
 * Keeping template arguments here allows receiver-bound fallback to match
 * specialization-specific class defs first; non-template behavior is preserved
 * by base-name fallback in resolveClassBindingForName.
 */
export function normalizeCppTypeName(text: string): string {
  let t = stripCppSpecifiers(text);
  // Strip pointer stars
  while (t.endsWith('*')) t = t.slice(0, -1).trim();
  while (t.startsWith('*')) t = t.slice(1).trim();
  // Strip reference markers
  while (t.endsWith('&')) t = t.slice(0, -1).trim();
  // Strip array brackets
  t = t.replace(/\[.*?\]/g, '').trim();
  // Strip struct/union/enum/class prefixes
  t = t.replace(/^(struct|union|enum|class)\s+/, '');
  // Strip leading :: (global namespace qualifier)
  t = t.replace(/^::/, '');
  return t;
}
