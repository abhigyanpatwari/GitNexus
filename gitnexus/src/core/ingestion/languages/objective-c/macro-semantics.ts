const MACROS = [
  { name: 'NS_ENUM', marker: 'E' },
  { name: 'NS_OPTIONS', marker: 'O' },
] as const;

function isWordBoundary(character: string | undefined): boolean {
  return character === undefined || !/[A-Za-z0-9_]/.test(character);
}

function blank(length: number): string {
  return ' '.repeat(length);
}

function macroReplacement(marker: string, typeName: string, originalLength: number): string | null {
  const replacement = `enum/*${marker}*/ ${typeName}`;
  return replacement.length <= originalLength
    ? `${replacement}${blank(originalLength - replacement.length)}`
    : null;
}

function macroArguments(source: string, start: number): { readonly end: number; readonly typeName: string } | null {
  const close = source.indexOf(')', start);
  if (close === -1) return null;
  const body = source.slice(start + 1, close);
  if (!/^[\x20-\x7E]*$/.test(body)) return null;
  const match = body.match(
    /^\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*\*+)?\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/,
  );
  return match === null ? null : { end: close + 1, typeName: match[1] };
}

function precedingTypedef(source: string, macroStart: number): { readonly start: number; readonly end: number } | null {
  let cursor = macroStart;
  while (cursor > 0 && /[ \t]/.test(source[cursor - 1]!)) cursor -= 1;
  const end = cursor;
  const start = end - 'typedef'.length;
  if (start < 0 || source.slice(start, end) !== 'typedef') return null;
  if (!isWordBoundary(source[start - 1])) return null;
  return { start, end };
}

/**
 * Rewrites only canonical, ASCII `typedef NS_ENUM/NS_OPTIONS` wrappers that
 * tree-sitter Objective-C cannot recover. The replacement preserves every
 * offset and newline and records a compact marker for AST-side annotations.
 */
export function preprocessObjectiveCMacroWrappers(sourceText: string, _filePath: string): string {
  if (!sourceText.includes('NS_ENUM') && !sourceText.includes('NS_OPTIONS')) return sourceText;

  const output = [...sourceText];
  let changed = false;
  let state: 'code' | 'string' | 'character' | 'line-comment' | 'block-comment' = 'code';

  for (let index = 0; index < sourceText.length; index += 1) {
    const character = sourceText[index]!;
    const next = sourceText[index + 1];
    if (state === 'line-comment') {
      if (character === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        state = 'code';
        index += 1;
      }
      continue;
    }
    if (state === 'string' || state === 'character') {
      if (character === '\\') {
        index += 1;
      } else if ((state === 'string' && character === '"') || (state === 'character' && character === "'")) {
        state = 'code';
      }
      continue;
    }
    if (character === '/' && next === '/') {
      state = 'line-comment';
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      state = 'block-comment';
      index += 1;
      continue;
    }
    if (character === '"') {
      state = 'string';
      continue;
    }
    if (character === "'") {
      state = 'character';
      continue;
    }

    const macro = MACROS.find(
      ({ name }) => sourceText.startsWith(`${name}(`, index) && isWordBoundary(sourceText[index - 1]),
    );
    if (macro === undefined) continue;
    const typedef = precedingTypedef(sourceText, index);
    const argumentsResult = macroArguments(sourceText, index + macro.name.length);
    if (typedef === null || argumentsResult === null) continue;
    const replacement = macroReplacement(macro.marker, argumentsResult.typeName, argumentsResult.end - index);
    if (replacement === null) continue;

    output.splice(typedef.start, typedef.end - typedef.start, ...blank(typedef.end - typedef.start));
    output.splice(index, argumentsResult.end - index, ...replacement);
    changed = true;
    index = argumentsResult.end - 1;
  }

  return changed ? output.join('') : sourceText;
}

export function objectiveCMacroAnnotation(text: string): string | null {
  if (text.includes('/*E*/')) return 'objc:ns-enum';
  if (text.includes('/*O*/')) return 'objc:ns-options';
  return null;
}
