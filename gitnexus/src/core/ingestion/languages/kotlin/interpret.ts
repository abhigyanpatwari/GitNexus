import type { CaptureMatch, ParsedImport, ParsedTypeBinding, TypeRef } from 'gitnexus-shared';

export function interpretKotlinImport(captures: CaptureMatch): ParsedImport | null {
  const kind = captures['@import.kind']?.text;
  const source = captures['@import.source']?.text;
  const name = captures['@import.name']?.text;
  if (kind === undefined || source === undefined) return null;

  switch (kind) {
    case 'named':
      return {
        kind: 'named',
        localName: name ?? source.split('.').pop() ?? source,
        importedName: name ?? source.split('.').pop() ?? source,
        targetRaw: source,
      };
    case 'alias': {
      const alias = captures['@import.alias']?.text;
      if (alias === undefined || name === undefined) return null;
      return {
        kind: 'alias',
        localName: alias,
        importedName: name,
        alias,
        targetRaw: source,
      };
    }
    case 'wildcard':
      return { kind: 'wildcard', targetRaw: source.endsWith('.*') ? source : `${source}.*` };
    default:
      return null;
  }
}

export function interpretKotlinTypeBinding(captures: CaptureMatch): ParsedTypeBinding | null {
  const nameCap = captures['@type-binding.name'];
  const typeCap = captures['@type-binding.type'];
  if (nameCap === undefined || typeCap === undefined) return null;

  let source: TypeRef['source'] = 'annotation';
  if (captures['@type-binding.self'] !== undefined) source = 'self';
  else if (captures['@type-binding.parameter'] !== undefined) source = 'parameter-annotation';
  else if (captures['@type-binding.return'] !== undefined) source = 'return-annotation';
  else if (captures['@type-binding.constructor'] !== undefined) source = 'constructor-inferred';

  return {
    boundName: nameCap.text,
    rawTypeName: normalizeKotlinType(typeCap.text),
    source,
  };
}

export function normalizeKotlinType(text: string): string {
  let out = text.trim();
  while (out.endsWith('?')) out = out.slice(0, -1).trim();
  const lastDot = out.lastIndexOf('.');
  if (lastDot >= 0) out = out.slice(lastDot + 1);

  const collection = out.match(
    /^(?:List|MutableList|ArrayList|Set|MutableSet|Collection|Iterable|Sequence|Array)<([^,<>]+)>$/,
  );
  if (collection !== null) return normalizeKotlinType(collection[1]!);

  const map = out.match(/^(?:Map|MutableMap|HashMap|LinkedHashMap)<[^,<>]+,\s*([^,<>]+)>$/);
  if (map !== null) return normalizeKotlinType(map[1]!);

  const erased = out.match(/^([A-Za-z_][A-Za-z0-9_]*)<.+>$/s);
  if (erased !== null) return erased[1]!;

  return out;
}
