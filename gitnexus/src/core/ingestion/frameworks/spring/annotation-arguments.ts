export interface SpringAnnotationArgument {
  readonly name?: string;
  readonly value: string;
}

function splitTopLevel(value: string, separator: string): string[] | null {
  const parts: string[] = [];
  const stack: string[] = [];
  let quote: '"' | "'" | '"""' | null = null;
  let escaped = false;
  let start = 0;

  // Angle brackets are deliberate: Java/Kotlin generic expressions may contain
  // commas that are not annotation-argument separators. Ambiguous comparison
  // expressions remain unsupported and fail closed instead of being mis-split.
  const closing = new Map([
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
    ['<', '>'],
  ]);

  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quote === '"""') {
      if (value.startsWith('"""', index)) {
        quote = null;
        index += 2;
      }
      continue;
    }
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (value.startsWith('"""', index)) {
      quote = '"""';
      index += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    const closingChar = closing.get(char);
    if (closingChar !== undefined) {
      stack.push(closingChar);
      continue;
    }
    if (stack[stack.length - 1] === char) {
      stack.pop();
      continue;
    }
    if (char === separator && stack.length === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quote !== null || stack.length > 0) return null;
  parts.push(value.slice(start).trim());
  return parts;
}

function topLevelAssignment(argument: string): number {
  const stack: string[] = [];
  let quote: '"' | "'" | '"""' | null = null;
  let escaped = false;
  // Keep the same deliberate generic-delimiter policy as splitTopLevel.
  const closing = new Map([
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
    ['<', '>'],
  ]);

  for (let index = 0; index < argument.length; index++) {
    const char = argument[index];
    if (quote === '"""') {
      if (argument.startsWith('"""', index)) {
        quote = null;
        index += 2;
      }
      continue;
    }
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (argument.startsWith('"""', index)) {
      quote = '"""';
      index += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    const closingChar = closing.get(char);
    if (closingChar !== undefined) {
      stack.push(closingChar);
      continue;
    }
    if (stack[stack.length - 1] === char) {
      stack.pop();
      continue;
    }
    if (char === '=' && stack.length === 0) return index;
  }
  return -1;
}

/** Parse Java/Kotlin annotation arguments without evaluating constants. */
export function parseSpringAnnotationArguments(
  annotationText: string,
): readonly SpringAnnotationArgument[] | null {
  const open = annotationText.indexOf('(');
  if (open === -1) return [];
  const close = annotationText.lastIndexOf(')');
  if (close < open || annotationText.slice(close + 1).trim().length > 0) return null;
  const body = annotationText.slice(open + 1, close).trim();
  if (body.length === 0) return [];
  const rawArguments = splitTopLevel(body, ',');
  if (rawArguments === null) return null;
  // Kotlin (and some formatters) allow a trailing comma. An empty *middle*
  // argument is still invalid and fail-closed.
  while (rawArguments.length > 0 && rawArguments[rawArguments.length - 1].length === 0) {
    rawArguments.pop();
  }
  if (rawArguments.some((argument) => argument.length === 0)) return null;

  const parsed: SpringAnnotationArgument[] = [];
  for (const raw of rawArguments) {
    const assignment = topLevelAssignment(raw);
    if (assignment === -1) {
      parsed.push({ value: raw });
      continue;
    }
    const name = raw.slice(0, assignment).trim();
    const value = raw.slice(assignment + 1).trim();
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) || value.length === 0) return null;
    parsed.push({ name, value });
  }
  return parsed;
}

export function parseStaticStringLiteral(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith('"""')) {
    if (trimmed.length < 6 || !trimmed.endsWith('"""')) return null;
    const raw = trimmed.slice(3, -3);
    if (raw.includes('"""') || /\$(?:\{|[A-Za-z_])/.test(raw)) return null;
    return raw;
  }
  const match = /^"((?:\\.|[^"\\])*)"$/s.exec(trimmed);
  if (match === null) return null;
  if (/(^|[^\\])\$(?:\{|[A-Za-z_])/.test(match[1])) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  }
}

/** Parse one string literal or a Java/Kotlin annotation string array. */
export function parseStaticStringValues(value: string): readonly string[] | null {
  const trimmed = value.trim();
  const pair =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'));
  const body = pair ? trimmed.slice(1, -1).trim() : trimmed;
  if (body.length === 0) return [];
  const parts = pair ? splitTopLevel(body, ',') : [body];
  if (parts === null) return null;
  const strings: string[] = [];
  for (const part of parts) {
    const parsed = parseStaticStringLiteral(part);
    if (parsed === null) return null;
    strings.push(parsed);
  }
  return strings;
}

/** Parse `Foo.class` or `Foo::class`; an Object/Any default returns an empty string. */
export function parseStaticClassLiteral(value: string): string | null {
  const compact = value.replace(/\s+/g, '');
  const match = /^([A-Za-z_$][A-Za-z0-9_$.]*)(?:\.class|::class)$/.exec(compact);
  if (match === null) return null;
  const typeName = match[1];
  if (
    typeName === 'Object' ||
    typeName === 'java.lang.Object' ||
    typeName === 'Any' ||
    typeName === 'kotlin.Any'
  ) {
    return '';
  }
  return typeName;
}

/** Normalize a declared bean type to the graph's simple/qualified raw type key. */
export function normalizeSpringBeanType(rawType: string): string | null {
  // Projection keywords are tokens only when separated from the following
  // type. Strip them before whitespace compaction so valid lowercase type
  // aliases such as `outputStream` and `inside.Type` remain intact.
  let normalized = rawType
    .replace(/^(?:out|in)\s+/, '')
    .replace(/([<,])\s*(?:out|in)\s+/g, '$1')
    .replace(/\s+/g, '')
    .replace(
      /^kotlin\.collections\.Mutable(List|Set|Collection|Map)(?=<|$)/,
      'kotlin.collections.$1',
    )
    .replace(/^Mutable(List|Set|Collection|Map)(?=<|$)/, '$1')
    .replace(/\?$/, '');
  const generic = normalized.indexOf('<');
  if (generic !== -1) {
    if (!normalized.endsWith('>')) return null;
    normalized = normalized.slice(0, generic);
  }
  if (
    normalized === 'void' ||
    normalized === 'Void' ||
    normalized === 'Unit' ||
    normalized === 'kotlin.Unit'
  ) {
    return null;
  }
  return /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(normalized)
    ? normalized
    : null;
}
