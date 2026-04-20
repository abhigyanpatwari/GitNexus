/**
 * Chunker Module
 *
 * Splits code nodes into chunks for embedding.
 * - Function/Method: AST-aware chunking by statement boundaries
 * - Other types: character-based sliding window fallback
 * - Short content (≤ chunkSize): no chunking
 */

export { type Chunk, characterChunk } from './character-chunk.js';

import { characterChunk } from './character-chunk.js';
import type { Chunk } from './character-chunk.js';
import { ensureAndParse, findDeclarationNode, findFunctionNode } from './ast-utils.js';
import { buildLineIndex, resolveChunkLines } from './line-index.js';
import {
  CHUNKING_RULES,
  CHUNK_MODE_AST_DECLARATION,
  CHUNK_MODE_AST_FUNCTION,
  type ChunkingRule,
} from './types.js';

/**
 * Main chunkNode function: dispatches by label
 */
export const chunkNode = async (
  label: string,
  content: string,
  filePath: string,
  startLine: number,
  endLine: number,
  chunkSize: number = 1200,
  overlap: number = 120,
): Promise<Chunk[]> => {
  // Content fits in one chunk — no splitting needed
  if (content.length <= chunkSize) {
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
  }

  const rule = CHUNKING_RULES[label];
  if (!rule) {
    return characterChunk(content, startLine, endLine, chunkSize, overlap);
  }

  try {
    if (rule.mode === CHUNK_MODE_AST_FUNCTION) {
      const astChunks = await astChunk(
        content,
        filePath,
        startLine,
        endLine,
        chunkSize,
        overlap,
        rule,
      );
      if (astChunks.length > 0) return astChunks;
    }

    if (rule.mode === CHUNK_MODE_AST_DECLARATION) {
      const declarationChunks = await declarationChunk(
        content,
        filePath,
        startLine,
        endLine,
        chunkSize,
        overlap,
        rule,
      );
      if (declarationChunks.length > 0) return declarationChunks;
    }
  } catch {
    // AST parsing failed — fall through to character fallback
  }

  // Character-based fallback for everything else
  return characterChunk(content, startLine, endLine, chunkSize, overlap);
};

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
): Promise<Chunk[]> => {
  const tree = await ensureAndParse(content, filePath);
  if (!tree) return [];

  const root = tree.rootNode;
  const lineOffsets = buildLineIndex(content);

  // Find the function/method declaration in the snippet AST.
  // tree-sitter parses node.content (a snippet), so rows are relative (0-based).
  const targetNode = findFunctionNode(root);
  if (!targetNode) return [];

  // Get the body (statements) via childForFieldName('body')
  const bodyNode = targetNode.childForFieldName('body');
  if (!bodyNode) return [];

  // Extract individual statements
  const statements: Array<{ startIndex: number; endIndex: number }> = [];
  for (let i = 0; i < bodyNode.namedChildCount; i++) {
    const child = bodyNode.namedChild(i);
    if (!child) continue;
    statements.push({
      startIndex: child.startIndex,
      endIndex: child.endIndex,
    });
  }

  if (statements.length === 0) return [];

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

const DECLARATION_BODY_NODE_TYPES = new Set([
  'class_body',
  'object_type',
  'declaration_list',
  'interface_body',
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
]);

const declarationChunk = async (
  content: string,
  filePath: string,
  startLine: number,
  endLine: number,
  chunkSize: number,
  overlap: number,
  rule: ChunkingRule,
): Promise<Chunk[]> => {
  const tree = await ensureAndParse(content, filePath);
  if (!tree) return [];

  const targetNode = findDeclarationNode(tree.rootNode);
  if (!targetNode) return [];

  const bodyNode = getDeclarationBodyNode(targetNode);
  if (!bodyNode) return [];

  const members = collectDeclarationUnits(bodyNode, rule.groupFields);
  if (members.length === 0) return [];

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

const chunkByUnits = (
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
): Chunk[] => {
  const chunks: Chunk[] = [];
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
      const oversizedChunks = characterChunk(
        content.slice(oversizedStartOffset, oversizedEndOffset),
        oversizedLineRange.startLine,
        oversizedLineRange.endLine,
        chunkSize,
        overlap,
      ).map((chunk, offsetIdx) => ({
        ...chunk,
        chunkIndex: chunks.length + offsetIdx,
        startOffset: chunk.startOffset + oversizedStartOffset,
        endOffset: chunk.endOffset + oversizedStartOffset,
      }));
      chunks.push(...oversizedChunks);
      chunkStartUnitIdx += 1;
      continue;
    }

    chunks.push(
      buildChunk(
        content,
        lineOffsets,
        chunks.length,
        chunkStartOffset,
        candidateEndOffset,
        baseStartLine,
      ),
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

  return chunks;
};

const findOverlapStartIndex = (
  statements: Array<{ startIndex: number; endIndex: number }>,
  chunkStartStmtIdx: number,
  chunkEndStmtIdx: number,
  overlapSize: number,
): number => {
  if (overlapSize <= 0) return chunkEndStmtIdx + 1;

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

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (DECLARATION_BODY_NODE_TYPES.has(child.type)) return child;
  }

  return null;
};

const collectDeclarationUnits = (
  bodyNode: any,
  groupFields: boolean,
): Array<{ startIndex: number; endIndex: number }> => {
  const members: Array<{ startIndex: number; endIndex: number; groupable: boolean }> = [];

  for (let i = 0; i < bodyNode.namedChildCount; i++) {
    const child = bodyNode.namedChild(i);
    if (!child) continue;
    members.push({
      startIndex: child.startIndex,
      endIndex: child.endIndex,
      groupable: groupFields && FIELD_LIKE_MEMBER_TYPES.has(child.type),
    });
  }

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
