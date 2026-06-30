/**
 * Text Generator Module
 *
 * Generates compact, description-forward embedding text from code nodes.
 * Supports chunkable labels (Function/Method with AST chunking),
 * Class-specific structural text, and short-node direct embed.
 *
 * Method/field names for Class nodes are extracted by the ingestion
 * pipeline's AST extractors and passed via node.methodNames/node.fieldNames.
 */

import type { EmbeddableNode, EmbeddingConfig } from './types.js';
import {
  CHUNKING_RULES,
  DEFAULT_EMBEDDING_CONFIG,
  STRUCTURAL_TEXT_MODE_DECLARATION,
  isShortLabel,
} from './types.js';

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
 * Compact location signal for the embedding header: the last 1-2 path segments
 * (immediate parent dir + basename), never the full deep path.
 *
 * #2333 / PR #2334 tri-review: U1 dropped the location entirely, which regressed
 * path/service-qualified semantic search (e.g. `billing/handler` vs
 * `identity/handler` in a monorepo) — and FTS indexes only name/content/description,
 * never `filePath`, so there is no keyword backfill. The bounded form restores the
 * discriminating tokens (service dir + filename-concept) at a fraction of the
 * dilution the full path caused.
 */
const boundedLocation = (filePath: string): string => {
  const segments = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return segments.slice(-2).join('/');
};

/**
 * Build a compact, description-forward header for embedding text.
 *
 * Issue #2333 (sub-issue of #2326), Option A: lead the embedding text with the
 * symbol name + doc-comment description and drop the low-signal metadata lines
 * (`Repo`/`Server`/`Export` and the verbose full `Path`). For short doc comments
 * those lines used to be ~25-30% of the embedding text, diluting the description's
 * semantic weight in the vector and weakening description-shaped search — worst
 * for CJK, where a complete concept is often 4-20 characters.
 *
 * A *bounded* location signal (last 1-2 path segments) is kept after the
 * description — see `boundedLocation` for why the full path drop was reversed.
 *
 * Full metadata is unaffected: it lives on the graph node properties, which is
 * what display/context tools read. Only the embedding text changes here.
 *
 * Option B (reorder only, keep metadata) was rejected — mean-pooled embeddings
 * weight by token proportion, not position, so reordering alone barely moves the
 * signal. Option C (a separate description-only embedding + hybrid merge) is
 * deferred to follow-up; build it only if Option A proves insufficient against
 * real measurement. Any change to this template MUST bump EMBEDDING_TEXT_VERSION.
 */
const buildEmbeddingHeader = (node: EmbeddableNode, config: Partial<EmbeddingConfig>): string => {
  const parts: string[] = [];

  // Label + name
  parts.push(`${node.label}: ${node.name}`);

  // Description hoisted above everything else so its semantic signal dominates
  // the embedding vector and is never the part lost to token-limit truncation.
  if (node.description) {
    const maxLen = config.maxDescriptionLength ?? DEFAULT_EMBEDDING_CONFIG.maxDescriptionLength;
    const truncated = truncateDescription(node.description, maxLen);
    if (truncated) {
      parts.push(truncated);
    }
  }

  // Bounded location signal — placed after the description so the description
  // still leads the vector. Restores path/service disambiguation lost when the
  // full Path line was dropped (FTS does not index filePath to backfill it).
  if (node.filePath) {
    const loc = boundedLocation(node.filePath);
    if (loc) {
      parts.push(`Loc: ${loc}`);
    }
  }

  return parts.join('\n');
};

const generateCodeBodyText = (
  node: EmbeddableNode,
  codeBody: string,
  config: Partial<EmbeddingConfig>,
  prevTail?: string,
): string => {
  const header = buildEmbeddingHeader(node, config);
  const parts = [header];
  if (prevTail) {
    parts.push(`[preceding context]: ...${cleanContent(prevTail)}`);
  }
  parts.push('', cleanContent(codeBody));
  return parts.join('\n');
};

const getCompactContainerContext = (
  cleanedContent: string,
  declarationOnly: string,
): string | undefined => {
  const source = declarationOnly || cleanedContent;
  const nlIdx = source.indexOf('\n');
  const firstLine = (nlIdx === -1 ? source : source.substring(0, nlIdx)).trim();
  return firstLine ? `Container: ${firstLine}` : undefined;
};

const generateStructuralTypeText = (
  node: EmbeddableNode,
  codeBody: string,
  config: Partial<EmbeddingConfig>,
  chunkIndex?: number,
  prevTail?: string,
): string => {
  const header = buildEmbeddingHeader(node, config);
  const parts: string[] = [header];
  const isFirstChunk = chunkIndex === undefined || chunkIndex === 0;
  const cleanedContent = cleanContent(node.content);
  const declarationOnly = extractDeclarationOnly(cleanedContent);
  const compactContainerContext = getCompactContainerContext(cleanedContent, declarationOnly);

  if (compactContainerContext) {
    parts.push(compactContainerContext);
  }

  if (prevTail) {
    parts.push(`[preceding context]: ...${cleanContent(prevTail)}`);
  }

  if (isFirstChunk && node.methodNames?.length) {
    parts.push(`Methods: ${node.methodNames.join(', ')}`);
  }
  if (isFirstChunk && node.fieldNames?.length) {
    parts.push(`Properties: ${node.fieldNames.join(', ')}`);
  }

  if (isFirstChunk && declarationOnly) {
    parts.push('', declarationOnly);
  }

  const cleanedChunk = cleanContent(codeBody);
  if (cleanedChunk && cleanedChunk !== cleanedContent) {
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
  chunkIndex?: number,
  prevTail?: string,
): string => {
  if (isShortLabel(node.label)) {
    const header = buildEmbeddingHeader(node, config);
    const cleaned = cleanContent(node.content);
    return `${header}\n\n${cleaned}`;
  }

  const chunkingRule = CHUNKING_RULES[node.label];
  if (chunkingRule?.structuralTextMode === STRUCTURAL_TEXT_MODE_DECLARATION) {
    return generateStructuralTypeText(node, codeBody, config, chunkIndex, prevTail);
  }

  return generateCodeBodyText(node, codeBody, config, prevTail);
};

/**
 * Export truncation helper for testing
 */
export { truncateDescription };
