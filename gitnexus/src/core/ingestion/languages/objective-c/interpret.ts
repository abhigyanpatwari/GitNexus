import type { CaptureMatch, ParsedImport, ParsedTypeBinding, TypeRef } from 'gitnexus-shared';

export function interpretObjectiveCImport(captures: CaptureMatch): ParsedImport | null {
  const source = captures['@import.source']?.text;
  if (source === undefined || captures['@import.system'] !== undefined) return null;
  return { kind: 'wildcard', targetRaw: source };
}

function stripObjectiveCProtocolQualifiers(text: string): string {
  let depth = 0;
  let result = '';

  for (const character of text) {
    if (character === '<') {
      depth++;
      continue;
    }
    if (character === '>') {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0) result += character;
  }

  return result;
}

export function normalizeObjectiveCType(text: string): string {
  return stripObjectiveCProtocolQualifiers(text)
    .trim()
    .replace(
      /\b(?:const|volatile|nullable|nonnull|__kindof|__weak|__strong|__unsafe_unretained)\b/g,
      '',
    )
    .replace(/\*+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function interpretObjectiveCTypeBinding(captures: CaptureMatch): ParsedTypeBinding | null {
  const name = captures['@type-binding.name']?.text;
  const type = captures['@type-binding.type']?.text;
  if (name === undefined || type === undefined) return null;

  let source: TypeRef['source'] = 'annotation';
  if (captures['@type-binding.self'] !== undefined) source = 'self';
  else if (captures['@type-binding.parameter'] !== undefined) source = 'parameter-annotation';
  else if (captures['@type-binding.return'] !== undefined) source = 'return-annotation';
  else if (captures['@type-binding.assignment'] !== undefined) source = 'assignment-inferred';

  return { boundName: name, rawTypeName: normalizeObjectiveCType(type), source };
}
