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

  return { boundName: name, rawTypeName: normalizeCppTypeName(type), source };
}

/**
 * Normalize a C++ type name: strip pointer/array/reference syntax,
 * qualifiers, and template parameters (V1: generic-ignored).
 */
export function normalizeCppTypeName(text: string): string {
  let t = text.trim();
  // Strip const, volatile, restrict, static, extern, inline, mutable, constexpr
  t = t
    .replace(/\b(const|volatile|restrict|static|extern|inline|mutable|constexpr|consteval)\b/g, '')
    .trim();
  // Strip template parameters (loop handles nested: Map<List<int>> → Map)
  while (t.includes('<')) {
    const stripped = t.replace(/<[^<>]*>/g, '');
    if (stripped === t) break; // avoid infinite loop on malformed input
    t = stripped;
  }
  t = t.trim();
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
