import type Parser from 'tree-sitter';
import type { ElementAccessRoute } from '../../scope-resolution/contract/scope-resolver.js';

/** JLS 3.8 Java letters (`Character.isJavaIdentifierStart`): letters, letter
 * numbers, currency symbols and connector punctuation. A character-class body
 * for `u`-flag patterns, so callers can add their own separators. */
export const JAVA_IDENTIFIER_START_CHARS = String.raw`\p{L}\p{Nl}\p{Sc}\p{Pc}`;
/** JLS 3.8 Java letters or digits (`Character.isJavaIdentifierPart`): adds
 * digits, combining marks and the identifier-ignorable characters
 * (`Character.isIdentifierIgnorable`): format characters and the ISO control
 * characters that are not whitespace. */
export const JAVA_IDENTIFIER_PART_CHARS = String.raw`${JAVA_IDENTIFIER_START_CHARS}\p{Nd}\p{Mn}\p{Mc}\p{Cf}\u0000-\u0008\u000E-\u001B\u007F-\u009F`;
/** One Java identifier. `.`, whitespace and brackets are outside both classes,
 * so anchored patterns built from it match in linear time. */
export const JAVA_IDENTIFIER = `[${JAVA_IDENTIFIER_START_CHARS}][${JAVA_IDENTIFIER_PART_CHARS}]*`;
/** A dotted name with no whitespace or comments between its parts. */
export const JAVA_QUALIFIED_NAME = `${JAVA_IDENTIFIER}(?:\\.${JAVA_IDENTIFIER})*`;
const nameGaps = new RegExp(
  `([${JAVA_IDENTIFIER_PART_CHARS}])\\s+(?=[${JAVA_IDENTIFIER_PART_CHARS}])|\\s+`,
  'gu',
);
/** Ignore spacing around punctuation while keeping separate identifier tokens separate. */
export const stripGaps = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, ' ')
    .replace(nameGaps, (_gap, preceding: string | undefined) => (preceding ? preceding + ' ' : ''));
/** Identifier characters and dots only: a written name without type
 * arguments, whitespace or comments. It checks characters, not segments. */
export const JAVA_DOTTED_SPELLING = new RegExp(`^[${JAVA_IDENTIFIER_PART_CHARS}.]+$`, 'u');

/** Preserve tokens such as wildcard bounds while removing whole annotations and comments. */
export function javaTypeTextWithoutTrivia(node: Parser.SyntaxNode): string {
  const written = node.text;
  if (!written.includes('@') && !written.includes('/')) return written;
  const omitted = node
    .descendantsOfType(['annotation', 'marker_annotation', 'block_comment', 'line_comment'])
    .sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex);
  let cursor = 0;
  let text = '';
  for (const part of omitted) {
    const start = part.startIndex - node.startIndex;
    if (start < cursor) continue; // An outer annotation already consumed it.
    text += written.slice(cursor, start) + ' ';
    cursor = part.endIndex - node.startIndex;
  }
  return text + written.slice(cursor);
}

/** Compact spelling for capture fields that encode types without whitespace. */
export function javaTypeText(node: Parser.SyntaxNode): string {
  return javaTypeTextWithoutTrivia(node).replace(/\s+/g, '');
}

/** Declarator dimensions belong only to that declarator (JLS 10.2). */
export function javaTrailingDimensions(node: Parser.SyntaxNode | null | undefined): string {
  const dimensions = node?.childForFieldName('dimensions');
  return '[]'.repeat(dimensions?.children.filter((child) => child.type === '[').length ?? 0);
}

/** Erasure retains the outer type and every array dimension, never its element. */
export function eraseJavaTypeArguments(text: string): string {
  let depth = 0;
  let result = '';
  for (const char of text) {
    if (char === '<') depth++;
    else if (char === '>') depth--;
    else if (depth === 0) result += char;
    if (depth < 0) return text;
  }
  return depth === 0 ? result : text;
}

/** Java brackets unwrap arrays only; collections have no bracket operator. */
export function javaArrayElementType(type: string, via: ElementAccessRoute): string | undefined {
  if (via.kind !== 'index') return undefined;
  const normalized = type.replace(/\s+/g, '');
  return normalized.endsWith('[]') ? normalized.slice(0, -2) : undefined;
}
