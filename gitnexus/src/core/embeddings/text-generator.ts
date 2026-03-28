/**
 * Text Generator Module
 *
 * Pure functions to generate embedding text from code nodes.
 * Combines node metadata with code snippets for semantic matching.
 */

import type { EmbeddableNode, EmbeddingConfig } from './types.js';
import { DEFAULT_EMBEDDING_CONFIG } from './types.js';

/**
 * Extract the filename from a file path
 */
const getFileName = (filePath: string): string => {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
};

/**
 * Extract the directory path from a file path
 */
const getDirectory = (filePath: string): string => {
  const parts = filePath.split('/');
  parts.pop();
  return parts.join('/') || '';
};

/**
 * Truncate content to max length, preserving word boundaries
 */
const truncateContent = (content: string, maxLength: number): string => {
  if (content.length <= maxLength) {
    return content;
  }

  // Find last space before maxLength to avoid cutting words
  const truncated = content.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');

  if (lastSpace > maxLength * 0.8) {
    return truncated.slice(0, lastSpace) + '...';
  }

  return truncated + '...';
};

/**
 * Clean code content for embedding
 * Removes excessive whitespace while preserving structure
 */
const cleanContent = (content: string): string => {
  return (
    content
      // Normalize line endings
      .replace(/\r\n/g, '\n')
      // Remove excessive blank lines (more than 2)
      .replace(/\n{3,}/g, '\n\n')
      // Trim each line
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .trim()
  );
};

/**
 * Generate embedding text for a Function node
 */
const generateFunctionText = (node: EmbeddableNode, maxSnippetLength: number): string => {
  const parts: string[] = [`Function: ${node.name}`, `File: ${getFileName(node.filePath)}`];

  const dir = getDirectory(node.filePath);
  if (dir) {
    parts.push(`Directory: ${dir}`);
  }

  if (node.content) {
    const cleanedContent = cleanContent(node.content);
    const snippet = truncateContent(cleanedContent, maxSnippetLength);
    parts.push('', snippet);
  }

  return parts.join('\n');
};

/**
 * Generate embedding text for a Class node
 */
const generateClassText = (node: EmbeddableNode, maxSnippetLength: number): string => {
  const parts: string[] = [`Class: ${node.name}`, `File: ${getFileName(node.filePath)}`];

  const dir = getDirectory(node.filePath);
  if (dir) {
    parts.push(`Directory: ${dir}`);
  }

  if (node.content) {
    const cleanedContent = cleanContent(node.content);
    const snippet = truncateContent(cleanedContent, maxSnippetLength);
    parts.push('', snippet);
  }

  return parts.join('\n');
};

/**
 * Generate embedding text for a Method node
 */
const generateMethodText = (node: EmbeddableNode, maxSnippetLength: number): string => {
  const parts: string[] = [`Method: ${node.name}`, `File: ${getFileName(node.filePath)}`];

  const dir = getDirectory(node.filePath);
  if (dir) {
    parts.push(`Directory: ${dir}`);
  }

  if (node.content) {
    const cleanedContent = cleanContent(node.content);
    const snippet = truncateContent(cleanedContent, maxSnippetLength);
    parts.push('', snippet);
  }

  return parts.join('\n');
};

/**
 * Generate embedding text for an Interface node
 */
const generateInterfaceText = (node: EmbeddableNode, maxSnippetLength: number): string => {
  const parts: string[] = [`Interface: ${node.name}`, `File: ${getFileName(node.filePath)}`];

  const dir = getDirectory(node.filePath);
  if (dir) {
    parts.push(`Directory: ${dir}`);
  }

  if (node.content) {
    const cleanedContent = cleanContent(node.content);
    const snippet = truncateContent(cleanedContent, maxSnippetLength);
    parts.push('', snippet);
  }

  return parts.join('\n');
};

/**
 * Generate embedding text for a File node
 * Uses file name and first N characters of content
 */
const generateFileText = (node: EmbeddableNode, maxSnippetLength: number): string => {
  const parts: string[] = [`File: ${node.name}`, `Path: ${node.filePath}`];

  if (node.content) {
    const cleanedContent = cleanContent(node.content);
    // For files, use a shorter snippet since they can be very long
    const snippet = truncateContent(cleanedContent, Math.min(maxSnippetLength, 300));
    parts.push('', snippet);
  }

  return parts.join('\n');
};

/**
 * Generate embedding text for any embeddable node
 * Dispatches to the appropriate generator based on node label
 *
 * @param node - The node to generate text for
 * @param config - Optional configuration for max snippet length
 * @returns Text suitable for embedding
 */
export const generateEmbeddingText = (
  node: EmbeddableNode,
  config: Partial<EmbeddingConfig> = {},
): string => {
  const maxSnippetLength = config.maxSnippetLength ?? DEFAULT_EMBEDDING_CONFIG.maxSnippetLength;

  switch (node.label) {
    case 'Function':
      return generateFunctionText(node, maxSnippetLength);
    case 'Class':
      return generateClassText(node, maxSnippetLength);
    case 'Method':
      return generateMethodText(node, maxSnippetLength);
    case 'Interface':
      return generateInterfaceText(node, maxSnippetLength);
    case 'File':
      return generateFileText(node, maxSnippetLength);
    default:
      // Fallback for any other embeddable type
      return `${node.label}: ${node.name}\nPath: ${node.filePath}`;
  }
};

/**
 * Generate embedding texts for a batch of nodes
 *
 * @param nodes - Array of nodes to generate text for
 * @param config - Optional configuration
 * @returns Array of texts in the same order as input nodes
 */
export const generateBatchEmbeddingTexts = (
  nodes: EmbeddableNode[],
  config: Partial<EmbeddingConfig> = {},
): string[] => {
  return nodes.map((node) => generateEmbeddingText(node, config));
};
