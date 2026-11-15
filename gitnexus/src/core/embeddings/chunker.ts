/**
 * Chunker Module
 *
 * Splits code nodes into chunks for embedding.
 * - Function/Method: AST-aware chunking by statement boundaries
 * - Other types: character-based sliding window fallback
 * - Short content (≤ chunkSize): no chunking
 */

export { type Chunk, characterChunk } from './character-chunk.js';

import { iterateCharacterChunks } from './character-chunk.js';
import type { Chunk } from './character-chunk.js';
import { ensureAndParse, findDeclarationNode, findFunctionNode } from './ast-utils.js';
import { buildLineIndex, resolveChunkLines } from './line-index.js';
import {
  CHUNKING_RULES,
  CHUNK_MODE_AST_DECLARATION,
  CHUNK_MODE_AST_FUNCTION,
  type ChunkingRule,
  type EmbeddingConfig,
} from './types.js';

export interface ChunkOptions {
  strategy?: EmbeddingConfig['chunkStrategy'];
  /** Disambiguate declarations sharing the indexed source lines. */
  name?: string;
  /** A transient parse shared with structural-name extraction. null means unavailable. */
  tree?: Awaited<ReturnType<typeof ensureAndParse>>;
}

export interface EmbeddingChunk extends Chunk {
  /** Present only after Class source has been structurally filtered. */
  classDeclaration?: string;
}

interface ChunkSyntaxNode {
  type: string;
  startIndex: number;
  endIndex: number;
  namedChildCount: number;
  namedChild(index: number): ChunkSyntaxNode | null;
  firstNamedChildForIndex?(index: number): ChunkSyntaxNode | null;
  previousNamedSibling?: ChunkSyntaxNode | null;
  childForFieldName?(name: string): ChunkSyntaxNode | null;
}

/** Find a sibling boundary without repeatedly walking native children by index. */
const childAtBoundary = (
  node: ChunkSyntaxNode,
  offset: number,
  side: 'before' | 'after',
): ChunkSyntaxNode | null => {
  if (node.firstNamedChildForIndex) {
    const after = node.firstNamedChildForIndex(offset);
    if (side === 'after' && after && after.startIndex <= offset) return after;
    const before = after
      ? (after.previousNamedSibling ?? null)
      : node.namedChild(node.namedChildCount - 1);
    // Native lookup can skip a named sibling across punctuation-only subtrees
    // (for example sparse array elements). Verify the gap before trusting it.
    if (!before || before.endIndex <= offset) return side === 'after' ? after : before;
  }
  let low = 0,
    high = node.namedChildCount;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((node.namedChild(mid)?.endIndex ?? Infinity) <= offset) low = mid + 1;
    else high = mid;
  }
  const index = side === 'before' ? low - 1 : low;
  return index >= 0 && index < node.namedChildCount ? node.namedChild(index) : null;
};

/**
 * Main chunkNode function: dispatches by label
 */
export const chunkNode = async (
  label: string,
  content: string,
  filePath: string,
  startLine: number,
  endLine: number,
  chunkSize = 1200,
  overlap = 120,
  options?: ChunkOptions,
): Promise<EmbeddingChunk[]> => {
  if (label !== 'Class' && content.length <= chunkSize)
    return [
      {
        text: content,
        chunkIndex: 0,
        startOffset: 0,
        endOffset: content.length,
        startLine,
        endLine,
      },
    ];
  return [
    ...(await prepareNodeChunks(
      label,
      content,
      filePath,
      startLine,
      endLine,
      chunkSize,
      overlap,
      options,
    )),
  ];
};

/** Yield chunks one at a time. Preparation retains source text and may retain
 * generated projection text for the node (including a joined class projection). */
export async function* iterateNodeChunks(
  label: string,
  content: string,
  filePath: string,
  startLine: number,
  endLine: number,
  chunkSize = 1200,
  overlap = 120,
  options?: ChunkOptions,
): AsyncGenerator<EmbeddingChunk> {
  yield* await prepareNodeChunks(
    label,
    content,
    filePath,
    startLine,
    endLine,
    chunkSize,
    overlap,
    options,
  );
}

async function prepareNodeChunks(
  label: string,
  content: string,
  filePath: string,
  startLine: number,
  endLine: number,
  chunkSize: number,
  overlap: number,
  options?: ChunkOptions,
): Promise<Iterable<EmbeddingChunk>> {
  // Even a short class contains implementations. Never fall back to raw Class
  // source: an unavailable parser yields identity/name metadata only.
  if (label === 'Class') {
    try {
      const tree =
        options?.tree === undefined ? await ensureAndParse(content, filePath) : options.tree;
      return projectClassChunks(
        content,
        tree,
        startLine,
        endLine,
        chunkSize,
        overlap,
        options?.strategy,
        options?.name,
      );
    } catch {
      return [classMetadataChunk(startLine, endLine)];
    }
  }
  if (content.length <= chunkSize) {
    return iterateCharacterChunks(content, startLine, endLine, chunkSize, overlap);
  }
  const rule = CHUNKING_RULES[label];
  if (!rule || options?.strategy === 'fixed') {
    return iterateCharacterChunks(content, startLine, endLine, chunkSize, overlap);
  }
  let chunks: Generator<Chunk> | undefined;
  try {
    if (rule?.mode === CHUNK_MODE_AST_FUNCTION) {
      chunks = await astChunk(
        content,
        filePath,
        startLine,
        endLine,
        chunkSize,
        overlap,
        rule,
        options?.name,
      );
    } else if (rule?.mode === CHUNK_MODE_AST_DECLARATION) {
      chunks = await declarationChunk(
        content,
        filePath,
        startLine,
        endLine,
        chunkSize,
        overlap,
        rule,
      );
    }
  } catch {
    // Only preparation may fall back. Never restart after yielding a chunk:
    // the consumer may already have durably stored it.
  }
  return chunks ?? iterateCharacterChunks(content, startLine, endLine, chunkSize, overlap);
}

/**
 * AST-based chunking for Function/Method
 * Parse snippet content, locate the function declaration node,
 * split body by statement boundaries.
 */
const astChunk = async (
  content: string,
  filePath: string,
  startLine: number,
  endLine: number,
  chunkSize: number,
  overlap: number,
  rule: ChunkingRule,
  expectedName?: string,
): Promise<Generator<Chunk> | undefined> => {
  const tree = await ensureAndParse(content, filePath);
  if (!tree) return undefined;

  const root = tree.rootNode;
  const lineOffsets = buildLineIndex(content);

  // Find the function/method declaration in the snippet AST.
  // tree-sitter parses node.content (a snippet), so rows are relative (0-based).
  const targetNode = findFunctionNode(root, expectedName);
  if (!targetNode) return undefined;

  // Get the body (statements) via childForFieldName('body')
  const bodyNode = targetNode.childForFieldName('body');
  if (!bodyNode) return undefined;

  // Extract individual statements
  const statements: Array<{ startIndex: number; endIndex: number }> = [];
  for (let i = 0; i < bodyNode.namedChildCount; i++) {
    const child = bodyNode.namedChild(i);
    if (!child) continue;
    if (child.endIndex - child.startIndex > chunkSize) {
      statements.push(
        ...refineOversizedStatement(
          child,
          chunkSize,
          overlap,
          i === 0 && rule.includePrefix ? targetNode.startIndex : child.startIndex,
        ),
      );
    } else {
      statements.push({ startIndex: child.startIndex, endIndex: child.endIndex });
    }
  }

  if (statements.length === 0) return undefined;

  // A fitting statement must not fall into character splitting just because
  // its function header or closing delimiters consume the remaining budget.
  const first = statements[0];
  const last = statements[statements.length - 1];
  const firstEnd =
    statements.length === 1 && rule.includeSuffix ? targetNode.endIndex : first.endIndex;
  if (
    rule.includePrefix &&
    first.startIndex > targetNode.startIndex &&
    first.endIndex - first.startIndex <= chunkSize &&
    firstEnd - targetNode.startIndex > chunkSize
  ) {
    statements.unshift({ startIndex: targetNode.startIndex, endIndex: first.startIndex });
  }
  if (
    rule.includeSuffix &&
    last.endIndex < targetNode.endIndex &&
    last.endIndex - last.startIndex <= chunkSize &&
    targetNode.endIndex - last.startIndex > chunkSize
  ) {
    statements.push({ startIndex: last.endIndex, endIndex: targetNode.endIndex });
  }

  return chunkByUnits(
    content,
    lineOffsets,
    startLine,
    chunkSize,
    overlap,
    statements,
    targetNode.startIndex,
    targetNode.endIndex,
    rule.includePrefix,
    rule.includeSuffix,
  );
};

/**
 * Adapted from ASTChunk's cAST split/merge algorithm:
 * https://github.com/yilinjz/astchunk/blob/82029ada8a8dd8d668283c076980cedb886e6d4c/src/astchunk/astchunk_builder.py
 * Descend oversized nodes and greedily pack fitting siblings. Use the existing
 * tree, a hard UTF-16 character budget (including gaps), and bounded overlap.
 * Retain oversized leaves for chunkByUnits' character fallback instead of
 * dropping them. An explicit stack avoids recursion limits on deep syntax.
 *
 * MIT License
 * Copyright (c) 2025 Yilin (Jason) Zhang
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const refineOversizedStatement = (
  statement: ChunkSyntaxNode,
  chunkSize: number,
  overlap: number,
  firstChunkStart: number,
): Array<{ startIndex: number; endIndex: number }> => {
  const boundaries: number[] = [];
  let cursor = firstChunkStart;
  const boundary = (end: number) => {
    if (end > cursor) {
      boundaries.push(end);
      cursor = end;
    }
  };
  const pending = [{ node: statement, offset: statement.startIndex }];
  while (pending.length) {
    const frame = pending.pop();
    if (!frame) break;
    const { node, offset } = frame;
    if (node.endIndex - node.startIndex <= chunkSize) {
      boundary(node.endIndex);
    } else {
      const first = childAtBoundary(node, offset, 'after');
      if (!first) {
        boundary(node.endIndex);
        continue;
      }
      const budgetEnd = cursor + chunkSize - (boundaries.length ? overlap : 0);
      if (first.endIndex > budgetEnd) {
        // Keep a fitting statement whole when a long branch header consumed
        // its space. Only oversized atoms reach the character fallback.
        if (first.startIndex > cursor) {
          boundary(first.startIndex);
          pending.push(frame);
        } else {
          pending.push({ node, offset: first.endIndex }, { node: first, offset: first.startIndex });
        }
        continue;
      }
      const end = childAtBoundary(node, budgetEnd, 'before')?.endIndex ?? first.endIndex;
      if (overlap > 0 && end > first.endIndex) {
        const tail = childAtBoundary(node, Math.max(offset, end - overlap - 1), 'after');
        if (tail && tail.endIndex < end) boundary(tail.endIndex);
      }
      boundary(end);
      pending.push({ node, offset: end });
    }
  }
  const units: Array<{ startIndex: number; endIndex: number }> = [];
  let startIndex = statement.startIndex;
  for (const endIndex of boundaries) {
    if (endIndex <= startIndex || endIndex > statement.endIndex) continue;
    units.push({ startIndex, endIndex });
    startIndex = endIndex;
  }
  if (startIndex < statement.endIndex) units.push({ startIndex, endIndex: statement.endIndex });
  return units;
};

const DECLARATION_BODY_NODE_TYPES = new Set([
  'class_body',
  'object_type',
  'declaration_list',
  'implementation_definition',
  'interface_body',
]);

const DIRECT_MEMBER_DECLARATION_TYPES = new Set([
  'protocol_declaration',
  'class_interface',
  // tree-sitter-objc exposes each implementation_definition directly under
  // class_implementation, rather than grouping them in a shared body node.
  'class_implementation',
]);

const DIRECT_MEMBER_HEADER_NODE_TYPES = new Set([
  'identifier',
  'parameterized_arguments',
  'protocol_reference_list',
  // tree-sitter-objc `_type_params` hides itself and exposes this named child
  // for `(T)` generics and category-shaped argument lists.
  'generic_arguments',
  // `_class_interface_header` / `_class_implementation_header` expose these
  // named children before members (`NS_ROOT_CLASS @interface …`).
  'attribute_declaration',
  'attribute_specifier',
  'availability_attribute_specifier',
  'ms_declspec_modifier',
  'storage_class_specifier',
  'type_qualifier',
]);

const FIELD_LIKE_MEMBER_TYPES = new Set([
  'field_definition',
  'public_field_definition',
  'property_definition',
  'property_signature',
  'variable_declarator',
  'lexical_declaration',
  'pair',
  'enum_assignment',
  // tree-sitter-objc wraps each ivar as `instance_variable`, not field_definition.
  'instance_variable',
]);

const DECLARATION_MEMBER_WRAPPER_TYPES = new Set([
  'qualified_protocol_interface_declaration',
  'instance_variables',
]);

/** Named prefixes the ObjC grammar allows immediately before each ivar. */
const IVAR_ATTRIBUTE_PREFIX_TYPES = new Set(['attribute_specifier', 'attribute_declaration']);

const declarationChunk = async (
  content: string,
  filePath: string,
  startLine: number,
  endLine: number,
  chunkSize: number,
  overlap: number,
  rule: ChunkingRule,
): Promise<Generator<Chunk> | undefined> => {
  const tree = await ensureAndParse(content, filePath);
  if (!tree) return undefined;

  const targetNode = findDeclarationNode(tree.rootNode);
  if (!targetNode) return undefined;

  const bodyNode = getDeclarationBodyNode(targetNode);
  if (!bodyNode) return undefined;

  const members = collectDeclarationUnits(bodyNode, rule.groupFields);
  if (members.length === 0) return undefined;

  return chunkByUnits(
    content,
    buildLineIndex(content),
    startLine,
    chunkSize,
    overlap,
    members,
    targetNode.startIndex,
    targetNode.endIndex,
    rule.includePrefix,
    rule.includeSuffix,
  );
};

const buildChunk = (
  content: string,
  lineOffsets: Int32Array,
  chunkIndex: number,
  startOffset: number,
  endOffset: number,
  baseStartLine: number,
): Chunk => {
  const lineRange = resolveChunkLines(lineOffsets, startOffset, endOffset, baseStartLine);
  return {
    text: content.slice(startOffset, endOffset),
    chunkIndex,
    startOffset,
    endOffset,
    startLine: lineRange.startLine,
    endLine: lineRange.endLine,
  };
};

function* chunkByUnits(
  content: string,
  lineOffsets: Int32Array,
  baseStartLine: number,
  chunkSize: number,
  overlap: number,
  units: Array<{ startIndex: number; endIndex: number }>,
  containerStartOffset: number,
  containerEndOffset: number,
  includeContainerPrefixOnFirstChunk: boolean,
  includeContainerSuffixOnLastChunk: boolean,
): Generator<Chunk> {
  let chunkIndex = 0;
  let chunkStartUnitIdx = 0;

  while (chunkStartUnitIdx < units.length) {
    const chunkStartOffset =
      chunkStartUnitIdx === 0 && includeContainerPrefixOnFirstChunk
        ? containerStartOffset
        : units[chunkStartUnitIdx].startIndex;

    let chunkEndUnitIdx = chunkStartUnitIdx;
    let candidateEndOffset =
      chunkEndUnitIdx === units.length - 1 && includeContainerSuffixOnLastChunk
        ? containerEndOffset
        : units[chunkEndUnitIdx].endIndex;

    while (chunkEndUnitIdx + 1 < units.length) {
      const nextEndOffset =
        chunkEndUnitIdx + 1 === units.length - 1 && includeContainerSuffixOnLastChunk
          ? containerEndOffset
          : units[chunkEndUnitIdx + 1].endIndex;
      if (nextEndOffset - chunkStartOffset > chunkSize) break;
      chunkEndUnitIdx += 1;
      candidateEndOffset = nextEndOffset;
    }

    if (candidateEndOffset - chunkStartOffset > chunkSize) {
      const oversizedUnit = units[chunkStartUnitIdx];
      const oversizedStartOffset =
        chunkStartUnitIdx === 0 && includeContainerPrefixOnFirstChunk
          ? containerStartOffset
          : oversizedUnit.startIndex;
      const oversizedEndOffset =
        chunkStartUnitIdx === units.length - 1 && includeContainerSuffixOnLastChunk
          ? containerEndOffset
          : oversizedUnit.endIndex;
      const oversizedLineRange = resolveChunkLines(
        lineOffsets,
        oversizedStartOffset,
        oversizedEndOffset,
        baseStartLine,
      );
      for (const chunk of iterateCharacterChunks(
        content.slice(oversizedStartOffset, oversizedEndOffset),
        oversizedLineRange.startLine,
        oversizedLineRange.endLine,
        chunkSize,
        overlap,
      )) {
        yield {
          ...chunk,
          chunkIndex: chunkIndex++,
          startOffset: chunk.startOffset + oversizedStartOffset,
          endOffset: chunk.endOffset + oversizedStartOffset,
        };
      }
      chunkStartUnitIdx += 1;
      continue;
    }

    yield buildChunk(
      content,
      lineOffsets,
      chunkIndex++,
      chunkStartOffset,
      candidateEndOffset,
      baseStartLine,
    );

    if (chunkEndUnitIdx === units.length - 1) {
      break;
    }

    const nextChunkStartUnitIdx = findOverlapStartIndex(
      units,
      chunkStartUnitIdx,
      chunkEndUnitIdx,
      overlap,
    );
    if (nextChunkStartUnitIdx <= chunkStartUnitIdx) {
      chunkStartUnitIdx = chunkEndUnitIdx + 1;
    } else {
      chunkStartUnitIdx = nextChunkStartUnitIdx;
    }
  }
}

const findOverlapStartIndex = (
  statements: Array<{ startIndex: number; endIndex: number }>,
  chunkStartStmtIdx: number,
  chunkEndStmtIdx: number,
  overlapSize: number,
): number => {
  if (overlapSize <= 0) return chunkEndStmtIdx + 1;

  // A single large statement is not an overlap-sized tail. Repeating it can
  // multiply the embedding work; the pipeline supplies bounded context when
  // no whole statement fits the overlap budget.
  const last = statements[chunkEndStmtIdx];
  if (last.endIndex - last.startIndex > overlapSize) return chunkEndStmtIdx + 1;

  let overlapStartIdx = chunkEndStmtIdx;
  while (overlapStartIdx > chunkStartStmtIdx) {
    const overlapLength =
      statements[chunkEndStmtIdx].endIndex - statements[overlapStartIdx - 1].startIndex;
    if (overlapLength > overlapSize) break;
    overlapStartIdx -= 1;
  }

  return overlapStartIdx;
};

const getDeclarationBodyNode = (node: any): any | null => {
  const bodyNode = node.childForFieldName?.('body');
  if (bodyNode) return bodyNode;

  if (DIRECT_MEMBER_DECLARATION_TYPES.has(node.type)) return node;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (DECLARATION_BODY_NODE_TYPES.has(child.type)) return child;
  }

  return null;
};

const classMetadataChunk = (startLine: number, endLine: number): EmbeddingChunk => ({
  text: '',
  chunkIndex: 0,
  startOffset: 0,
  endOffset: 0,
  startLine,
  endLine,
  classDeclaration: '',
});

const CLASS_FIELD_TYPES = new Set([
  ...FIELD_LIKE_MEMBER_TYPES,
  'field_declaration',
  'property_declaration',
  'variable_declaration',
  'constant_declaration',
  'assignment',
]);

type DeclarationSpan = { startIndex: number; endIndex: number };

const declarationSpans = (
  nodes: ChunkSyntaxNode[],
  startIndex: number,
  endIndex: number,
): DeclarationSpan[] => {
  const excluded: DeclarationSpan[] = [];
  const pending = [...nodes];
  while (pending.length) {
    const current = pending.pop()!;
    // Kotlin/Swift closures and C# expression getters expose executable
    // groups without a named body field.
    const implementation =
      current.childForFieldName?.('body') ??
      (current.type === 'statements' ||
      current.type === 'function_body' ||
      current.type === 'arrow_expression_clause'
        ? current
        : null);
    if (implementation) {
      excluded.push(implementation);
      continue;
    }
    for (let i = current.namedChildCount - 1; i >= 0; i--) {
      const child = current.namedChild(i);
      if (child) pending.push(child);
    }
  }
  excluded.sort((a, b) => a.startIndex - b.startIndex);
  const spans: DeclarationSpan[] = [];
  let cursor = startIndex;
  for (const cut of excluded) {
    if (cut.startIndex > cursor) spans.push({ startIndex: cursor, endIndex: cut.startIndex });
    cursor = Math.max(cursor, cut.endIndex);
  }
  if (cursor < endIndex) spans.push({ startIndex: cursor, endIndex });
  return spans;
};

/** Retained spans are packed by their own size, never by the removed methods'
 * size. Map projected offsets back to original source for search line ranges. */
const projectClassChunks = (
  content: string,
  tree: Awaited<ReturnType<typeof ensureAndParse>>,
  startLine: number,
  endLine: number,
  chunkSize: number,
  overlap: number,
  strategy: EmbeddingConfig['chunkStrategy'] = 'ast',
  expectedName?: string,
): Iterable<EmbeddingChunk> => {
  const target = tree && findDeclarationNode(tree.rootNode, expectedName);
  const body = target && getDeclarationBodyNode(target);
  if (!body || target.hasError) return [classMetadataChunk(startLine, endLine)];

  const fields: Array<{ node: ChunkSyntaxNode; startIndex: number; endIndex: number }> = [];
  let firstMemberStart: number | undefined;
  const groups: ChunkSyntaxNode[] = [body];
  while (groups.length) {
    const group = groups.pop();
    if (!group) break;
    const firstField = fields.length;
    let attributeStart: number | undefined;
    for (let i = 0; i < group.namedChildCount; i++) {
      const child = group.namedChild(i);
      if (!child) continue;
      if (group === target && DIRECT_MEMBER_HEADER_NODE_TYPES.has(child.type)) continue;
      firstMemberStart = Math.min(firstMemberStart ?? child.startIndex, child.startIndex);
      if (DECLARATION_MEMBER_WRAPPER_TYPES.has(child.type)) {
        groups.push(child);
      } else if (
        group.type === 'instance_variables' &&
        IVAR_ATTRIBUTE_PREFIX_TYPES.has(child.type)
      ) {
        attributeStart ??= child.startIndex;
      } else {
        const assignment =
          child.type === 'expression_statement' && child.namedChild(0)?.type === 'assignment';
        const signature =
          child.type === 'method_signature' ||
          (child.type === 'method_declaration' && !child.childForFieldName?.('body'));
        if (CLASS_FIELD_TYPES.has(child.type) || assignment || signature) {
          fields.push({
            node: child,
            startIndex: attributeStart ?? child.startIndex,
            // Some grammars keep the field's semicolon as an unnamed sibling.
            endIndex: child.endIndex + (content[child.endIndex] === ';' ? 1 : 0),
          });
        }
        attributeStart = undefined;
      }
    }
    if (group.type === 'instance_variables' && fields.length > firstField) {
      fields[firstField].startIndex = group.startIndex;
      fields[fields.length - 1].endIndex = group.endIndex;
    }
  }
  fields.sort((a, b) => a.startIndex - b.startIndex);
  const headerEnd = firstMemberStart ?? (body === target ? target.endIndex : body.startIndex + 1);
  const headerNodes: ChunkSyntaxNode[] = [];
  for (let i = 0; i < target.namedChildCount; i++) {
    const child = target.namedChild(i);
    // Inspect constructor defaults and heritage expressions, not the class body.
    if (child && child.endIndex <= headerEnd) headerNodes.push(child);
  }
  const headerSpans = declarationSpans(
    headerNodes,
    target.startIndex,
    target.startIndex + content.slice(target.startIndex, headerEnd).trimEnd().length,
  );
  const header = headerSpans
    .map((span) => content.slice(span.startIndex, span.endIndex))
    .join('\n');
  const sourceGroups: DeclarationSpan[][] = header ? [headerSpans] : [];
  for (const { node, startIndex, endIndex } of fields) {
    const spans = declarationSpans([node], startIndex, endIndex);
    if (spans.length) sourceGroups.push(spans);
  }

  const segments: Array<{ start: number; end: number; source: number }> = [];
  const units: DeclarationSpan[] = [];
  const pieces: string[] = [];
  let length = 0;
  for (const spans of sourceGroups) {
    const unitStart = length;
    for (const span of spans) {
      if (length) {
        pieces.push('\n');
        length++;
      }
      const text = content.slice(span.startIndex, span.endIndex);
      segments.push({ start: length, end: length + text.length, source: span.startIndex });
      pieces.push(text);
      length += text.length;
    }
    units.push({ startIndex: unitStart, endIndex: length });
  }
  if (!length) return [classMetadataChunk(startLine, endLine)];
  const projected = pieces.join('');
  const chunks =
    strategy === 'fixed'
      ? iterateCharacterChunks(projected, 1, 1, chunkSize, overlap)
      : chunkByUnits(
          projected,
          buildLineIndex(projected),
          1,
          chunkSize,
          overlap,
          units,
          0,
          length,
          true,
          true,
        );
  const originalLines = buildLineIndex(content);
  const sourceOffset = (offset: number): number => {
    let low = 0,
      high = segments.length - 1;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (segments[mid].end <= offset) low = mid + 1;
      else high = mid;
    }
    const segment = segments[low];
    return (
      segment.source + Math.max(0, Math.min(offset - segment.start, segment.end - segment.start))
    );
  };
  return (function* () {
    for (const chunk of chunks) {
      const startOffset = sourceOffset(chunk.startOffset);
      const endOffset = sourceOffset(chunk.endOffset - 1) + 1;
      yield {
        ...chunk,
        startOffset,
        endOffset,
        ...resolveChunkLines(originalLines, startOffset, endOffset, startLine),
        classDeclaration: header,
      };
    }
  })();
};

const collectDeclarationUnits = (
  bodyNode: any,
  groupFields: boolean,
): Array<{ startIndex: number; endIndex: number }> => {
  const members: Array<{ startIndex: number; endIndex: number; groupable: boolean }> = [];

  const collectMembers = (
    node: any,
    skipHeaderChildren: boolean,
    includeNodePrefixOnFirstMember = false,
  ): void => {
    const firstMemberIndex = members.length;
    let ivarAttributePrefixStart: number | undefined;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (DECLARATION_MEMBER_WRAPPER_TYPES.has(child.type)) {
        collectMembers(child, false, true);
        continue;
      }
      if (skipHeaderChildren && DIRECT_MEMBER_HEADER_NODE_TYPES.has(child.type)) continue;
      if (node.type === 'instance_variables' && IVAR_ATTRIBUTE_PREFIX_TYPES.has(child.type)) {
        ivarAttributePrefixStart ??= child.startIndex;
        continue;
      }
      members.push({
        startIndex: ivarAttributePrefixStart ?? child.startIndex,
        endIndex: child.endIndex,
        groupable: groupFields && FIELD_LIKE_MEMBER_TYPES.has(child.type),
      });
      ivarAttributePrefixStart = undefined;
    }

    const firstMember = members[firstMemberIndex];
    if (includeNodePrefixOnFirstMember && firstMember) {
      firstMember.startIndex = node.startIndex;
      if (node.type === 'instance_variables') {
        members[members.length - 1].endIndex = node.endIndex;
      }
    }
  };

  collectMembers(bodyNode, DIRECT_MEMBER_DECLARATION_TYPES.has(bodyNode.type));

  if (members.length === 0) return [];

  const grouped: Array<{ startIndex: number; endIndex: number }> = [];
  let current = members[0];

  for (let i = 1; i < members.length; i++) {
    const next = members[i];
    if (current.groupable && next.groupable) {
      current = {
        startIndex: current.startIndex,
        endIndex: next.endIndex,
        groupable: true,
      };
      continue;
    }
    grouped.push({ startIndex: current.startIndex, endIndex: current.endIndex });
    current = next;
  }

  grouped.push({ startIndex: current.startIndex, endIndex: current.endIndex });
  return grouped;
};
