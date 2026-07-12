/**
 * Capture-match interpreters for Solidity imports / type bindings.
 *
 * Import matches arrive pre-decomposed by `emitSolidityScopeCaptures`
 * (one binding per match, with `@import.kind/source/name/alias` markers).
 */

import type { CaptureMatch, ParsedImport, ParsedTypeBinding, TypeRef } from 'gitnexus-shared';

function stripQuotes(raw: string): string {
  return raw.replace(/^['"]|['"]$/g, '').trim();
}

export function interpretSolidityImport(captures: CaptureMatch): ParsedImport | null {
  const kindCap = captures['@import.kind'];
  const sourceCap = captures['@import.source'];
  if (kindCap === undefined || sourceCap === undefined) return null;

  const targetRaw = stripQuotes(sourceCap.text);
  if (targetRaw === '') return null;

  const nameCap = captures['@import.name'];
  const aliasCap = captures['@import.alias'];

  switch (kindCap.text) {
    case 'named': {
      const importedName = nameCap?.text.trim();
      if (!importedName) return null;
      return {
        kind: 'named',
        localName: importedName,
        importedName,
        targetRaw,
      };
    }
    case 'alias': {
      const importedName = nameCap?.text.trim();
      const alias = aliasCap?.text.trim();
      if (!importedName || !alias) return null;
      return {
        kind: 'alias',
        localName: alias,
        importedName,
        alias,
        targetRaw,
      };
    }
    case 'namespace': {
      const localName = aliasCap?.text.trim() || nameCap?.text.trim();
      if (!localName) return null;
      return {
        kind: 'namespace',
        localName,
        importedName: targetRaw,
        targetRaw,
      };
    }
    case 'wildcard':
      return { kind: 'wildcard', targetRaw };
    default:
      return null;
  }
}

export function interpretSolidityTypeBinding(captures: CaptureMatch): ParsedTypeBinding | null {
  const nameCap = captures['@type-binding.name'];
  const typeCap = captures['@type-binding.type'];
  if (nameCap === undefined || typeCap === undefined) return null;

  let source: TypeRef['source'] = 'parameter-annotation';
  if (captures['@type-binding.self'] !== undefined) source = 'self';
  else if (captures['@type-binding.return'] !== undefined) source = 'return-annotation';
  else if (captures['@type-binding.annotation'] !== undefined) source = 'annotation';

  return {
    boundName: nameCap.text.trim(),
    rawTypeName: typeCap.text.trim(),
    source,
  };
}
