const MACROS = [
  { name: 'NS_ENUM', marker: 'E' },
  { name: 'NS_OPTIONS', marker: 'O' },
] as const;

const ASSUME_NONNULL_MARKERS = {
  begin: 'NS_ASSUME_NONNULL_BEGIN',
  end: 'NS_ASSUME_NONNULL_END',
} as const;
const ASSUME_SENTINEL_SLOTS = ['0', '1', '2', '3'] as const;

type AssumeMarkerKind = keyof typeof ASSUME_NONNULL_MARKERS;
type AssumeSentinelSlot = (typeof ASSUME_SENTINEL_SLOTS)[number];

interface MacroArguments {
  readonly end: number;
  readonly typeName: string;
  readonly typeNameEnd: number;
  readonly typeNameStart: number;
  readonly underlyingType: string;
}

interface MacroArgumentScan {
  readonly closed: boolean;
  readonly nextIndex: number;
  readonly argumentsResult: MacroArguments | null;
}

interface BlockCommentScan {
  readonly closed: boolean;
  readonly nextIndex: number;
}

interface QuotedLiteralScan {
  readonly closed: boolean;
  readonly nextIndex: number;
}

interface TriviaScan {
  readonly closed: boolean;
  readonly nextIndex: number;
}

interface SignificantToken {
  readonly end: number;
  readonly kind: 'identifier' | 'other';
  readonly start: number;
  readonly text?: string;
}

interface TextEdit {
  readonly end: number;
  readonly replacement: string;
  readonly start: number;
}

interface AssumeMarker {
  readonly end: number;
  readonly kind: AssumeMarkerKind;
  readonly start: number;
}

export interface ObjectiveCSourceRange {
  readonly end: number;
  readonly start: number;
}

const MAX_SOURCE_LENGTH = 1024 * 1024;
const MAX_MACRO_CANDIDATES = 4_096;
const MAX_ASSUME_MARKERS = 4_096;
const TYPE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNDERLYING_TYPE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\s+[A-Za-z_][A-Za-z0-9_]*)*(?:\s*\*+)?$/;

function isIdentifierStart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z_]/.test(character);
}

function isIdentifierPart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_]/.test(character);
}

function assumeMarkerKind(identifier: string): AssumeMarkerKind | null {
  if (identifier === ASSUME_NONNULL_MARKERS.begin) return 'begin';
  if (identifier === ASSUME_NONNULL_MARKERS.end) return 'end';
  return null;
}

function blank(length: number): string {
  return ' '.repeat(length);
}

function scanBlockComment(source: string, start: number): BlockCommentScan {
  let index = start + 2;
  while (index < source.length) {
    if (source[index] === '*' && source[index + 1] === '/') {
      return { closed: true, nextIndex: index + 2 };
    }
    index += 1;
  }
  return { closed: false, nextIndex: source.length };
}

function scanQuotedLiteral(source: string, start: number, quote: '"' | "'"): QuotedLiteralScan {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += Math.min(2, source.length - index);
      continue;
    }
    const character = source[index];
    index += 1;
    if (character === quote) return { closed: true, nextIndex: index };
  }
  return { closed: false, nextIndex: source.length };
}

function skipTrivia(source: string, start: number): TriviaScan {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source.charAt(index))) {
      index += 1;
      continue;
    }
    if (source[index] === '/' && source[index + 1] === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
        index += 1;
      }
      continue;
    }
    if (source[index] === '/' && source[index + 1] === '*') {
      const comment = scanBlockComment(source, index);
      if (!comment.closed) return comment;
      index = comment.nextIndex;
      continue;
    }
    break;
  }
  return { closed: true, nextIndex: index };
}

function containsLineBreak(source: string, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (source[index] === '\n' || source[index] === '\r') return true;
  }
  return false;
}

function skipPreprocessorDirective(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] !== '\n' && source[index] !== '\r') {
      index += 1;
      continue;
    }

    const lineBreakStart = index;
    if (source[index] === '\r' && source[index + 1] === '\n') index += 1;
    index += 1;
    if (source[lineBreakStart - 1] !== '\\') return index;
  }
  return source.length;
}

function macroReplacement(
  marker: string,
  typeName: string,
  underlyingType: string,
  originalLength: number,
): string | null {
  const replacement = `enum${macroSemanticComment(marker, underlyingType)} ${typeName}`;
  return replacement.length <= originalLength
    ? `${replacement}${blank(originalLength - replacement.length)}`
    : null;
}

function macroSemanticComment(marker: string, underlyingType: string): string {
  return `/*GN$${marker}:${underlyingType.replace(/\s+/g, '+')}*/`;
}

function parsedMacroArguments(
  source: string,
  open: number,
  comma: number | null,
  close: number,
): MacroArguments | null {
  if (comma === null) return null;
  let underlyingStart = open + 1;
  let underlyingEnd = comma;
  let typeNameStart = comma + 1;
  let typeNameEnd = close;
  while (underlyingStart < underlyingEnd && /\s/.test(source.charAt(underlyingStart))) {
    underlyingStart += 1;
  }
  while (underlyingEnd > underlyingStart && /\s/.test(source.charAt(underlyingEnd - 1))) {
    underlyingEnd -= 1;
  }
  while (typeNameStart < typeNameEnd && /\s/.test(source.charAt(typeNameStart))) {
    typeNameStart += 1;
  }
  while (typeNameEnd > typeNameStart && /\s/.test(source.charAt(typeNameEnd - 1))) {
    typeNameEnd -= 1;
  }
  const underlyingType = source.slice(underlyingStart, underlyingEnd);
  const typeName = source.slice(typeNameStart, typeNameEnd);
  if (!UNDERLYING_TYPE_PATTERN.test(underlyingType) || !TYPE_NAME_PATTERN.test(typeName)) {
    return null;
  }
  return { end: close + 1, typeName, typeNameEnd, typeNameStart, underlyingType };
}

/**
 * Scans one candidate through its balanced closing parenthesis. The caller
 * advances directly to `nextIndex`, so every candidate interval is visited at
 * most once, including malformed candidates that consume the rest of a file.
 */
function scanMacroArguments(source: string, open: number): MacroArgumentScan {
  let depth = 1;
  let comma: number | null = null;
  let multipleTopLevelCommas = false;
  let index = open + 1;

  while (index < source.length) {
    const character = source.charAt(index);
    const next = source[index + 1];
    if (character === '/' && next === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
        index += 1;
      }
      continue;
    }
    if (character === '/' && next === '*') {
      const comment = scanBlockComment(source, index);
      if (!comment.closed) {
        return { closed: false, nextIndex: source.length, argumentsResult: null };
      }
      index = comment.nextIndex;
      continue;
    }
    if (character === '"') {
      const literal = scanQuotedLiteral(source, index, '"');
      if (!literal.closed) {
        return { closed: false, nextIndex: source.length, argumentsResult: null };
      }
      index = literal.nextIndex;
      continue;
    }
    if (character === "'") {
      const literal = scanQuotedLiteral(source, index, "'");
      if (!literal.closed) {
        return { closed: false, nextIndex: source.length, argumentsResult: null };
      }
      index = literal.nextIndex;
      continue;
    }
    if (character === '(') {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        const argumentsResult = multipleTopLevelCommas
          ? null
          : parsedMacroArguments(source, open, comma, index);
        return { closed: true, nextIndex: index + 1, argumentsResult };
      }
      index += 1;
      continue;
    }
    if (character === ',' && depth === 1) {
      if (comma === null) comma = index;
      else multipleTopLevelCommas = true;
    }
    index += 1;
  }

  return { closed: false, nextIndex: source.length, argumentsResult: null };
}

function newlinePreservingMacroReplacement(
  source: string,
  typedefStart: number,
  macroStart: number,
  marker: string,
  macroArguments: MacroArguments,
): string | null {
  const wrapper = source.slice(typedefStart, macroArguments.end);
  if (!/^[\x00-\x7f]*$/.test(wrapper)) return null;

  const characters: string[] = wrapper
    .split('')
    .map((character) => (character === '\r' || character === '\n' ? character : ' '));
  const typeNameStart = macroArguments.typeNameStart - typedefStart;
  const typeNameEnd = macroArguments.typeNameEnd - typedefStart;
  const markerStart = macroStart - typedefStart;
  const semanticMarker = macroSemanticComment(marker, macroArguments.underlyingType);
  const availableMarkerPositions: number[] = [];

  for (let index = markerStart; index < typeNameStart; index += 1) {
    if (wrapper[index] !== '\r' && wrapper[index] !== '\n') {
      availableMarkerPositions.push(index);
    }
  }
  const markerPrefix = semanticMarker.slice(0, -2);
  const firstMarkerPosition = availableMarkerPositions[0];
  const secondMarkerPosition = availableMarkerPositions[1];
  if (
    availableMarkerPositions.length < semanticMarker.length ||
    firstMarkerPosition === undefined ||
    secondMarkerPosition !== firstMarkerPosition + 1
  ) {
    return null;
  }

  let closingPositionIndex = -1;
  for (let index = markerPrefix.length; index + 1 < availableMarkerPositions.length; index += 1) {
    const currentPosition = availableMarkerPositions[index];
    if (
      currentPosition !== undefined &&
      availableMarkerPositions[index + 1] === currentPosition + 1
    ) {
      closingPositionIndex = index;
      break;
    }
  }
  if (closingPositionIndex === -1) return null;

  for (let index = 0; index < 'enum'.length; index += 1) {
    characters[index] = 'enum'.charAt(index);
  }
  for (let index = 0; index < markerPrefix.length; index += 1) {
    const position = availableMarkerPositions[index];
    if (position === undefined) return null;
    characters[position] = markerPrefix.charAt(index);
  }
  const closingStart = availableMarkerPositions[closingPositionIndex];
  const closingEnd = availableMarkerPositions[closingPositionIndex + 1];
  if (closingStart === undefined || closingEnd === undefined) return null;
  characters[closingStart] = '*';
  characters[closingEnd] = '/';
  for (let index = typeNameStart; index < typeNameEnd; index += 1) {
    characters[index] = wrapper.charAt(index);
  }
  return characters.join('');
}

function encodeAssumeOffset(value: number): string {
  return value.toString(36).padStart(4, '0');
}

function assumeSentinel(
  kind: AssumeMarkerKind,
  slot: AssumeSentinelSlot,
  start: number,
  sourceLength: number,
): string {
  const kindMarker = kind === 'begin' ? 'B' : 'E';
  const filler = kind === 'begin' ? '$$$$$' : '$$$';
  return `/*GN$A${slot}${kindMarker}${encodeAssumeOffset(start)}${encodeAssumeOffset(sourceLength)}${filler}*/`;
}

function selectAssumeSentinelSlot(source: string): AssumeSentinelSlot | null {
  return ASSUME_SENTINEL_SLOTS.find((slot) => !source.includes(`/*GN$A${slot}`)) ?? null;
}

/**
 * Rewrites the Objective-C macro forms that tree-sitter cannot recover:
 * `typedef NS_ENUM/NS_OPTIONS` wrappers become equivalent enum syntax, while
 * assume-nonnull markers become position-validated comments that the capture phase
 * can still balance. Every edit is ASCII-only, length-preserving, and keeps
 * each CR/LF at its original offset.
 */
export function preprocessObjectiveCMacroWrappers(sourceText: string, _filePath: string): string {
  if (sourceText.length > MAX_SOURCE_LENGTH) return sourceText;
  if (
    !MACROS.some((macro) => sourceText.includes(macro.name)) &&
    !Object.values(ASSUME_NONNULL_MARKERS).some((marker) => sourceText.includes(marker))
  ) {
    return sourceText;
  }

  const edits: TextEdit[] = [];
  const assumeMarkers: AssumeMarker[] = [];
  let candidateCount = 0;
  let index = 0;
  let logicalLineStart = true;
  let previousToken: SignificantToken | null = null;

  while (index < sourceText.length) {
    const character = sourceText.charAt(index);
    const next = sourceText[index + 1];
    if (/\s/.test(character)) {
      if (character === '\n' || character === '\r') logicalLineStart = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '/') {
      index += 2;
      while (
        index < sourceText.length &&
        sourceText[index] !== '\n' &&
        sourceText[index] !== '\r'
      ) {
        index += 1;
      }
      continue;
    }
    if (character === '/' && next === '*') {
      const commentStart = index;
      const comment = scanBlockComment(sourceText, index);
      if (!comment.closed) return sourceText;
      if (containsLineBreak(sourceText, commentStart, comment.nextIndex)) {
        logicalLineStart = true;
      }
      index = comment.nextIndex;
      continue;
    }
    if (character === '"' || character === "'") {
      const start = index;
      const literal = scanQuotedLiteral(sourceText, index, character);
      if (!literal.closed) return sourceText;
      index = literal.nextIndex;
      logicalLineStart = false;
      previousToken = { start, end: index, kind: 'other' };
      continue;
    }
    if (character === '#' && logicalLineStart) {
      const start = index;
      index = skipPreprocessorDirective(sourceText, index);
      logicalLineStart = true;
      previousToken = { start, end: index, kind: 'other' };
      continue;
    }

    if (!isIdentifierStart(character)) {
      logicalLineStart = false;
      previousToken = { start: index, end: index + 1, kind: 'other' };
      index += 1;
      continue;
    }

    const identifierStart = index;
    index += 1;
    while (index < sourceText.length && isIdentifierPart(sourceText[index])) index += 1;
    const identifier = sourceText.slice(identifierStart, index);
    logicalLineStart = false;
    const assumeKind = assumeMarkerKind(identifier);
    if (assumeKind !== null) {
      assumeMarkers.push({ start: identifierStart, end: index, kind: assumeKind });
      if (assumeMarkers.length > MAX_ASSUME_MARKERS) return sourceText;
      previousToken = { start: identifierStart, end: index, kind: 'other' };
      continue;
    }

    const macro = MACROS.find((candidate) => candidate.name === identifier);
    if (macro === undefined) {
      previousToken = {
        start: identifierStart,
        end: index,
        kind: 'identifier',
        text: identifier,
      };
      continue;
    }

    const trivia = skipTrivia(sourceText, index);
    if (!trivia.closed) return sourceText;
    if (sourceText[trivia.nextIndex] !== '(') {
      previousToken = {
        start: identifierStart,
        end: index,
        kind: 'identifier',
        text: identifier,
      };
      continue;
    }

    candidateCount += 1;
    if (candidateCount > MAX_MACRO_CANDIDATES) return sourceText;
    const argumentScan = scanMacroArguments(sourceText, trivia.nextIndex);
    if (!argumentScan.closed) return sourceText;
    const argumentsResult = argumentScan.argumentsResult;
    if (
      argumentsResult !== null &&
      previousToken?.kind === 'identifier' &&
      previousToken.text === 'typedef'
    ) {
      const wrapper = sourceText.slice(previousToken.start, argumentsResult.end);
      const replacement = !/^[\x00-\x7f]*$/.test(wrapper)
        ? null
        : wrapper.includes('\n') || wrapper.includes('\r')
          ? newlinePreservingMacroReplacement(
              sourceText,
              previousToken.start,
              identifierStart,
              macro.marker,
              argumentsResult,
            )
          : macroReplacement(
              macro.marker,
              argumentsResult.typeName,
              argumentsResult.underlyingType,
              wrapper.length,
            );
      if (replacement !== null) {
        edits.push({ start: previousToken.start, end: argumentsResult.end, replacement });
      }
    }
    index = argumentScan.nextIndex;
    previousToken = { start: identifierStart, end: index, kind: 'other' };
  }

  if (assumeMarkers.length > 0) {
    const sentinelSlot = selectAssumeSentinelSlot(sourceText);
    if (sentinelSlot === null) return sourceText;
    for (const marker of assumeMarkers) {
      const replacement = assumeSentinel(
        marker.kind,
        sentinelSlot,
        marker.start,
        sourceText.length,
      );
      if (replacement.length !== marker.end - marker.start) return sourceText;
      edits.push({ start: marker.start, end: marker.end, replacement });
    }
  }

  if (edits.length === 0) return sourceText;
  edits.sort((left, right) => left.start - right.start);
  const output: string[] = [];
  let unchangedStart = 0;
  for (const edit of edits) {
    if (edit.start < unchangedStart || edit.replacement.length !== edit.end - edit.start) {
      return sourceText;
    }
    output.push(sourceText.slice(unchangedStart, edit.start), edit.replacement);
    unchangedStart = edit.end;
  }
  output.push(sourceText.slice(unchangedStart));
  return output.join('');
}

interface DecodedAssumeSentinel {
  readonly end: number;
  readonly kind: AssumeMarkerKind;
  readonly slot: AssumeSentinelSlot;
  readonly start: number;
}

function decodeAssumeSentinel(
  comment: string,
  start: number,
  sourceLength: number,
): DecodedAssumeSentinel | null {
  const match = comment.match(
    /^\/\*GN\$A([0-3])([BE])([0-9a-z]{4})([0-9a-z]{4})(\${3}|\${5})\*\/$/,
  );
  if (match === null) return null;
  const [, slot, kindMarker, encodedStart, encodedLength, filler] = match;
  if (
    slot === undefined ||
    kindMarker === undefined ||
    encodedStart === undefined ||
    encodedLength === undefined
  ) {
    return null;
  }
  const kind = kindMarker === 'B' ? 'begin' : 'end';
  if (filler !== (kind === 'begin' ? '$$$$$' : '$$$')) return null;
  if (Number.parseInt(encodedStart, 36) !== start) return null;
  if (Number.parseInt(encodedLength, 36) !== sourceLength) return null;
  return {
    start,
    end: start + comment.length,
    kind,
    slot: slot as AssumeSentinelSlot,
  };
}

/** Returns only fully balanced, position-validated assume-nonnull regions. */
export function objectiveCAssumeNonnullRanges(source: string): readonly ObjectiveCSourceRange[] {
  if (source.length > MAX_SOURCE_LENGTH) return [];
  const sentinels: DecodedAssumeSentinel[] = [];
  let index = 0;
  let logicalLineStart = true;

  while (index < source.length) {
    const character = source.charAt(index);
    const next = source[index + 1];
    if (/\s/.test(character)) {
      if (character === '\n' || character === '\r') logicalLineStart = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
        index += 1;
      }
      continue;
    }
    if (character === '/' && next === '*') {
      const commentStart = index;
      const comment = scanBlockComment(source, index);
      if (!comment.closed) return [];
      const decoded = decodeAssumeSentinel(
        source.slice(commentStart, comment.nextIndex),
        commentStart,
        source.length,
      );
      if (decoded !== null) sentinels.push(decoded);
      if (containsLineBreak(source, commentStart, comment.nextIndex)) logicalLineStart = true;
      index = comment.nextIndex;
      continue;
    }
    if (character === '"' || character === "'") {
      const literal = scanQuotedLiteral(source, index, character);
      if (!literal.closed) return [];
      index = literal.nextIndex;
      logicalLineStart = false;
      continue;
    }
    if (character === '#' && logicalLineStart) {
      index = skipPreprocessorDirective(source, index);
      logicalLineStart = true;
      continue;
    }
    if (!isIdentifierStart(character)) {
      logicalLineStart = false;
      index += 1;
      continue;
    }
    const identifierStart = index;
    index += 1;
    while (index < source.length && isIdentifierPart(source[index])) index += 1;
    const identifier = source.slice(identifierStart, index);
    logicalLineStart = false;
    if (assumeMarkerKind(identifier) !== null) return [];
  }

  const slots = new Set(sentinels.map((sentinel) => sentinel.slot));
  if (slots.size !== 1) return [];
  const ranges: ObjectiveCSourceRange[] = [];
  const stack: number[] = [];
  for (const sentinel of sentinels) {
    if (sentinel.kind === 'begin') {
      stack.push(sentinel.end);
      continue;
    }
    const begin = stack.pop();
    if (begin === undefined) return [];
    if (stack.length === 0) ranges.push({ start: begin, end: sentinel.start });
  }
  return stack.length === 0 ? ranges : [];
}

interface SemanticMacroMarker {
  readonly kind: 'E' | 'O';
  readonly underlyingType: string;
}

function skipPreservedLineBreaks(text: string, start: number): number {
  let index = start;
  while (text[index] === '\r' || text[index] === '\n') index += 1;
  return index;
}

function semanticMacroMarker(text: string): SemanticMacroMarker | null {
  if (!text.startsWith('enum') || isIdentifierPart(text[4])) return null;

  let index = 'enum'.length;
  while (text[index] === ' ' || text[index] === '\r' || text[index] === '\n') index += 1;
  if (text[index] !== '/' || text[index + 1] !== '*') return null;
  index += 2;

  for (const expected of 'GN$') {
    index = skipPreservedLineBreaks(text, index);
    if (text[index] !== expected) return null;
    index += 1;
  }
  index = skipPreservedLineBreaks(text, index);
  const kind = text[index];
  if (kind !== 'E' && kind !== 'O') return null;
  index += 1;
  index = skipPreservedLineBreaks(text, index);
  if (text[index] !== ':') return null;
  index += 1;

  const encodedCharacters: string[] = [];
  let paddingStarted = false;
  while (index < text.length) {
    if (text[index] === '*' && text[index + 1] === '/') {
      const encodedUnderlyingType = encodedCharacters.join('');
      const underlyingType = encodedUnderlyingType.replace(/\+/g, ' ');
      return encodedUnderlyingType.length > 0 &&
        underlyingType.replace(/\s+/g, '+') === encodedUnderlyingType &&
        UNDERLYING_TYPE_PATTERN.test(underlyingType)
        ? { kind, underlyingType }
        : null;
    }

    const character = text[index];
    index += 1;
    if (character === '\r' || character === '\n') continue;
    if (character === ' ') {
      paddingStarted = true;
      continue;
    }
    if (character === undefined || paddingStarted) return null;
    encodedCharacters.push(character);
  }
  return null;
}

export function objectiveCMacroAnnotation(text: string): string | null {
  const marker = semanticMacroMarker(text);
  return marker?.kind === 'E' ? 'objc:ns-enum' : marker?.kind === 'O' ? 'objc:ns-options' : null;
}

export function objectiveCMacroUnderlyingType(text: string): string | null {
  const semanticMarker = semanticMacroMarker(text);
  return semanticMarker?.underlyingType ?? null;
}
