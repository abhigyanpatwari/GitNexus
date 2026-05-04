import type { CaptureMatch, ParsedImport, ParsedTypeBinding, TypeRef } from 'gitnexus-shared';

export function interpretGoImport(captures: CaptureMatch): ParsedImport | null {
  const kind = captures['@import.kind']?.text;
  const source = captures['@import.source']?.text;
  const name = captures['@import.name']?.text;
  const alias = captures['@import.alias']?.text;
  if (kind === undefined || source === undefined) return null;

  if (kind === 'dot') return { kind: 'wildcard', targetRaw: source };
  if (kind === 'alias') {
    if (alias === undefined || name === undefined) return null;
    return { kind: 'namespace', localName: alias, importedName: name, targetRaw: source };
  }
  if (kind === 'namespace') {
    if (name === undefined) return null;
    return { kind: 'namespace', localName: name, importedName: name, targetRaw: source };
  }
  return null;
}

export function interpretGoTypeBinding(captures: CaptureMatch): ParsedTypeBinding | null {
  const name = captures['@type-binding.name']?.text;
  const type = captures['@type-binding.type']?.text;
  if (name === undefined || type === undefined) return null;

  let source: TypeRef['source'] = 'annotation';
  let normalizedType: string;
  if (captures['@type-binding.self'] !== undefined) {
    source = 'self';
    normalizedType = normalizeGoTypeName(type);
  } else if (captures['@type-binding.constructor'] !== undefined) {
    source = 'constructor-inferred';
    normalizedType = normalizeGoTypeName(type);
  } else if (captures['@type-binding.call-return'] !== undefined) {
    source = 'constructor-inferred';
    normalizedType = normalizeGoTypeName(type);
  } else if (captures['@type-binding.assertion'] !== undefined) {
    source = 'annotation';
    normalizedType = normalizeGoTypeName(type);
  } else if (captures['@type-binding.new'] !== undefined) {
    source = 'constructor-inferred';
    normalizedType = normalizeGoTypeName(type);
  } else if (captures['@type-binding.field'] !== undefined) {
    source = 'assignment-inferred';
    normalizedType = normalizeGoTypeName(type);
  } else if (captures['@type-binding.range'] !== undefined) {
    source = 'constructor-inferred';
    normalizedType = normalizeGoTypeName(type);
  } else if (captures['@type-binding.index'] !== undefined) {
    source = 'constructor-inferred';
    normalizedType = normalizeGoTypeName(type);
  } else if (captures['@type-binding.multi-assign'] !== undefined) {
    source = 'constructor-inferred';
    normalizedType = normalizeGoTypeName(type);
  } else if (captures['@type-binding.make'] !== undefined) {
    source = 'constructor-inferred';
    normalizedType = normalizeGoTypeName(type);
  } else if (captures['@type-binding.return'] !== undefined) {
    // Preserve dotted names for cross-package return-type chains.
    source = 'return-annotation';
    normalizedType = normalizeGoReturnType(type);
  } else if (captures['@type-binding.alias'] !== undefined) {
    source = 'assignment-inferred';
    normalizedType = normalizeGoTypeName(type);
  } else if (captures['@type-binding.assignment'] !== undefined) {
    source = 'assignment-inferred';
    normalizedType = normalizeGoTypeName(type);
  } else if (captures['@type-binding.parameter'] !== undefined) {
    source = 'parameter-annotation';
    normalizedType = normalizeGoTypeName(type);
  } else {
    normalizedType = normalizeGoTypeName(type);
  }

  return { boundName: name, rawTypeName: normalizedType, source };
}

export function normalizeGoTypeName(text: string): string {
  let t = text.trim();
  while (t.startsWith('*')) t = t.slice(1).trim();
  if (t.startsWith('[]')) t = t.slice(2).trim();
  const mapMatch = t.match(/^map\[[^\]]+\]\s*(.+)$/);
  if (mapMatch) t = mapMatch[1].trim();
  t = t.replace(/^(?:<-)?chan\s+/, '');
  if (t.startsWith('func(')) {
    const retMatch = t.match(/^func\([^)]*\)\s*(.*)$/);
    if (retMatch) t = retMatch[1].trim();
  }
  const dot = t.lastIndexOf('.');
  if (dot !== -1) t = t.slice(dot + 1);
  const bracket = t.indexOf('[');
  if (bracket !== -1) t = t.slice(0, bracket);
  return t;
}

/**
 * Like `normalizeGoTypeName` but preserves dotted package-prefix
 * (`models.User` stays `models.User`). Used for return-type
 * annotations so cross-package type chains can resolve through
 * QualifiedNameIndex (which carries `pkg.Type` entries).
 */
export function normalizeGoReturnType(text: string): string {
  let t = text.trim();
  // Multi-return syntax: (*T, error) → extract first type. Handles
  // the common Go pattern where functions return (value, error).
  if (t.startsWith('(') && t.includes(',')) {
    const closeIdx = t.indexOf(',');
    t = t.slice(1, closeIdx).trim();
  }
  while (t.startsWith('*')) t = t.slice(1).trim();
  if (t.startsWith('[]')) t = t.slice(2).trim();
  const mapMatch = t.match(/^map\[[^\]]+\]\s*(.+)$/);
  if (mapMatch) t = mapMatch[1].trim();
  t = t.replace(/^(?:<-)?chan\s+/, '');
  if (t.startsWith('func(')) {
    const retMatch = t.match(/^func\([^)]*\)\s*(.*)$/);
    if (retMatch) t = retMatch[1].trim();
  }
  // Preserve dotted qualified names for cross-package resolution.
  const bracket = t.indexOf('[');
  if (bracket !== -1) t = t.slice(0, bracket);
  return t;
}
