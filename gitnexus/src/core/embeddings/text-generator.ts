/**
 * Text Generator Module
 *
 * Generates enriched embedding text from code nodes with metadata.
 * Supports chunkable labels (Function/Method with AST chunking),
 * Class-specific structural text, and short-node direct embed.
 *
 * Method/field names for Class nodes are extracted by the ingestion
 * pipeline's AST extractors and passed via node.methodNames/node.fieldNames.
 */

import type { EmbeddableNode, EmbeddingConfig } from './types.js';
import { DEFAULT_EMBEDDING_CONFIG, isShortLabel } from './types.js';

/**
 * Truncate description to max length at sentence/word boundary
 */
const truncateDescription = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) return text;

  const truncated = text.slice(0, maxLength);

  // Try sentence boundary (. ! ?)
  const sentenceEnd = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('! '),
    truncated.lastIndexOf('? '),
  );
  if (sentenceEnd > maxLength * 0.5) {
    return truncated.slice(0, sentenceEnd + 1);
  }

  // Try word boundary
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLength * 0.5) {
    return truncated.slice(0, lastSpace);
  }

  return truncated;
};

/**
 * Clean code content for embedding
 */
const cleanContent = (content: string): string => {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
};

/**
 * Build metadata header for a node
 */
const buildMetadataHeader = (node: EmbeddableNode, config: Partial<EmbeddingConfig>): string => {
  const parts: string[] = [];

  // Label + name
  parts.push(`${node.label}: ${node.name}`);

  // Repo name
  if (node.repoName) {
    parts.push(`Repo: ${node.repoName}`);
  }

  // Server name (optional)
  if (node.serverName) {
    parts.push(`Server: ${node.serverName}`);
  }

  // Full file path
  parts.push(`Path: ${node.filePath}`);

  // Export status
  if (node.isExported !== undefined) {
    parts.push(`Export: ${node.isExported}`);
  }

  // Description (truncated)
  if (node.description) {
    const maxLen = config.maxDescriptionLength ?? DEFAULT_EMBEDDING_CONFIG.maxDescriptionLength;
    const truncated = truncateDescription(node.description, maxLen);
    if (truncated) {
      parts.push(truncated);
    }
  }

  return parts.join('\n');
};

const generateCodeBodyText = (
  node: EmbeddableNode,
  codeBody: string,
  config: Partial<EmbeddingConfig>,
): string => {
  const header = buildMetadataHeader(node, config);
  const cleaned = cleanContent(codeBody);
  return `${header}\n\n${cleaned}`;
};

/**
 * Generate embedding text for Class nodes
 * Signature + properties + method name list only (no method bodies)
 * Method/field names come from AST extractors via node.methodNames/node.fieldNames.
 */
const generateClassText = (
  node: EmbeddableNode,
  codeBody: string,
  config: Partial<EmbeddingConfig>,
): string => {
  return generateStructuralTypeText(node, codeBody, config);
};

const generateStructuralTypeText = (
  node: EmbeddableNode,
  codeBody: string,
  config: Partial<EmbeddingConfig>,
): string => {
  const header = buildMetadataHeader(node, config);
  const parts: string[] = [header];

  if (node.methodNames?.length) {
    parts.push(`Methods: ${node.methodNames.join(', ')}`);
  }
  if (node.fieldNames?.length) {
    parts.push(`Properties: ${node.fieldNames.join(', ')}`);
  }

  const declarationOnly = extractDeclarationOnly(cleanContent(node.content));
  if (declarationOnly) {
    parts.push('', declarationOnly);
  }

  const cleanedChunk = cleanContent(codeBody);
  if (cleanedChunk && cleanedChunk !== cleanContent(node.content)) {
    parts.push('', cleanedChunk);
  }

  return parts.join('\n');
};

const DECL_START_RE =
  /^(?:(?:export|pub|data|abstract)\s+)*(?:type\s+\w+\s+struct|(?:class|struct|enum|interface)\s)/;

/**
 * Extract class/interface/struct declaration lines, skipping method bodies.
 * - Brace-based languages: detects method signatures (lines with `(` and `{`)
 *   and skips until depth returns to class body level.
 * - Non-brace languages (Python/Ruby): returns empty string (patterns handle extraction).
 */
export const extractDeclarationOnly = (content: string): string => {
  const lines = content.split('\n');
  const declLines: string[] = [];
  let depth = 0;
  let started = false;
  let classDepth = 0;
  let skipDepth = 0;

  for (const [idx, line] of lines.entries()) {
    const trimmed = line.trim();

    if (!started) {
      if (DECL_START_RE.test(trimmed)) {
        // Non-brace language check: current line or next 3 lines must have `{`
        const nextLines = lines.slice(idx + 1, idx + 4);
        if (!trimmed.includes('{') && !nextLines.some((l) => l.includes('{'))) {
          return '';
        }
        started = true;
        declLines.push(trimmed);
        for (const ch of trimmed) {
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
        }
        if (depth > 0) classDepth = depth;
      }
      continue;
    }

    // Always update depth (even when skipping)
    const opens = (trimmed.match(/{/g) || []).length;
    const closes = (trimmed.match(/}/g) || []).length;
    const prevDepth = depth;
    depth += opens - closes;

    if (skipDepth > 0) {
      if (depth <= classDepth) {
        skipDepth = 0;
        // Closing brace of class
        if (depth <= 0) {
          declLines.push(trimmed);
          break;
        }
      }
      continue;
    }

    // Detect method signature: line has both `(` and `{` and goes deeper than class body
    const hasParens = trimmed.includes('(');
    const hasOpenBrace = opens > 0;
    if (hasParens && hasOpenBrace && prevDepth + opens > classDepth) {
      if (opens === closes && trimmed.endsWith(';')) {
        // Property with function/object initializer like `config = { timeout: 5000 };` — keep
        declLines.push(trimmed);
      }
      // else: single-line or multi-line method — skip entirely
      if (opens !== closes) {
        skipDepth = classDepth;
      }
      continue;
    }

    declLines.push(trimmed);

    if (depth <= 0 && declLines.length > 1) break;
  }

  return declLines.join('\n').trim();
};

/**
 * Generate embedding text for any embeddable node
 * Dispatches to the appropriate generator based on node label
 */
export const generateEmbeddingText = (
  node: EmbeddableNode,
  codeBody: string,
  config: Partial<EmbeddingConfig> = {},
): string => {
  if (isShortLabel(node.label)) {
    const header = buildMetadataHeader(node, config);
    const cleaned = cleanContent(node.content);
    return `${header}\n\n${cleaned}`;
  }

  if (node.label === 'Class') {
    return generateClassText(node, codeBody, config);
  }

  if (node.label === 'Interface') {
    return generateStructuralTypeText(node, codeBody, config);
  }

  return generateCodeBodyText(node, codeBody, config);
};

/**
 * Export truncation helper for testing
 */
export { truncateDescription };
