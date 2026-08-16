export type ObjectiveCReceiverForm = 'instance' | 'class-object' | 'dynamic' | 'related-result';

export interface ObjectiveCTypeDescriptor {
  readonly raw: string;
  readonly baseName?: string;
  readonly protocols: readonly string[];
  readonly typeArguments: readonly string[];
  readonly qualifiers: readonly string[];
  readonly receiverForm: ObjectiveCReceiverForm;
}

const MAX_TYPE_LENGTH = 4_096;
const MAX_NESTING = 16;
const QUALIFIERS = new Set([
  'const',
  'volatile',
  'nullable',
  'nonnull',
  'null_unspecified',
  '_Nullable',
  '_Nonnull',
  '_Null_unspecified',
  '__nullable',
  '__nonnull',
  '__null_unspecified',
  '__kindof',
  '__weak',
  '__strong',
  '__unsafe_unretained',
  '__autoreleasing',
]);
const GENERIC_BASES = new Set(['NSArray', 'NSDictionary', 'NSSet', 'NSOrderedSet']);
const IDENTIFIER_PATTERN = /^[_\p{ID_Start}][_\p{ID_Continue}\u200C\u200D]*/u;

function readIdentifier(text: string): string | null {
  return IDENTIFIER_PATTERN.exec(text)?.[0] ?? null;
}

function dynamicDescriptor(raw: string): ObjectiveCTypeDescriptor {
  return {
    raw,
    protocols: [],
    typeArguments: [],
    qualifiers: [],
    receiverForm: 'dynamic',
  };
}

function findMatchingAngle(text: string, start: number): number | null {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === '<') {
      depth += 1;
      if (depth > MAX_NESTING) return null;
    } else if (character === '>') {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return null;
    }
  }
  return null;
}

function splitTopLevel(text: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '<') {
      depth += 1;
      if (depth > MAX_NESTING) return null;
    } else if (character === '>') {
      depth -= 1;
      if (depth < 0) return null;
    } else if (character === ',' && depth === 0) {
      const part = text.slice(start, index).trim();
      if (part === '') return null;
      parts.push(part);
      start = index + 1;
    }
  }
  if (depth !== 0) return null;
  const finalPart = text.slice(start).trim();
  if (finalPart === '') return null;
  parts.push(finalPart);
  return parts;
}

function isProtocolList(parts: readonly string[], baseName: string): boolean {
  if (GENERIC_BASES.has(baseName)) return false;
  return parts.every((part) => readIdentifier(part) === part);
}

/**
 * Parses only bounded Objective-C declaration syntax. Anything ambiguous or
 * malformed is deliberately dynamic so dispatch never falls back to a guess.
 */
export function parseObjectiveCTypeDescriptor(text: string): ObjectiveCTypeDescriptor {
  const raw = text;
  const normalized = text.trim();
  if (normalized === '' || normalized.length > MAX_TYPE_LENGTH) return dynamicDescriptor(raw);

  let cursor = 0;
  const qualifiers: string[] = [];
  const consumeWhitespace = (): void => {
    while (/\s/.test(normalized[cursor] ?? '')) cursor += 1;
  };
  const consumeQualifier = (): boolean => {
    const identifier = readIdentifier(normalized.slice(cursor));
    if (identifier === null || !QUALIFIERS.has(identifier)) return false;
    qualifiers.push(identifier);
    cursor += identifier.length;
    return true;
  };

  consumeWhitespace();
  while (consumeQualifier()) consumeWhitespace();

  const baseName = readIdentifier(normalized.slice(cursor));
  if (baseName === null) return dynamicDescriptor(raw);
  cursor += baseName.length;
  consumeWhitespace();

  let parts: readonly string[] = [];
  if (normalized[cursor] === '<') {
    const end = findMatchingAngle(normalized, cursor);
    if (end === null) return dynamicDescriptor(raw);
    const parsedParts = splitTopLevel(normalized.slice(cursor + 1, end));
    if (parsedParts === null) return dynamicDescriptor(raw);
    parts = parsedParts;
    cursor = end + 1;
  }

  while (cursor < normalized.length) {
    consumeWhitespace();
    if (normalized[cursor] === '*') {
      cursor += 1;
      continue;
    }
    if (consumeQualifier()) continue;
    if (cursor === normalized.length) break;
    return dynamicDescriptor(raw);
  }

  if (baseName === 'instancetype') {
    return {
      raw,
      protocols: [],
      typeArguments: [],
      qualifiers,
      receiverForm: 'related-result',
    };
  }
  if (baseName === 'id') {
    return {
      raw,
      baseName,
      protocols: parts,
      typeArguments: [],
      qualifiers,
      receiverForm: parts.length === 0 ? 'dynamic' : 'instance',
    };
  }
  if (baseName === 'Class') {
    return {
      raw,
      baseName,
      protocols: parts,
      typeArguments: [],
      qualifiers,
      receiverForm: 'class-object',
    };
  }

  const protocolList = isProtocolList(parts, baseName);
  return {
    raw,
    baseName,
    protocols: protocolList ? parts : [],
    typeArguments: protocolList ? [] : parts,
    qualifiers,
    receiverForm: 'instance',
  };
}
