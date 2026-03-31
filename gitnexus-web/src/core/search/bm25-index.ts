/**
 * BM25 Full-Text Search Index
 *
 * Uses MiniSearch for fast keyword-based search with BM25 ranking.
 * Complements semantic search - BM25 finds exact terms, semantic finds concepts.
 */

import MiniSearch from "minisearch";

export interface BM25Document {
  id: string; // File path
  content: string; // File content
  name: string; // File name (boosted in search)
}

export interface BM25SearchResult {
  filePath: string;
  score: number;
  rank: number;
}

/**
 * BM25 Index singleton
 * Stores the MiniSearch instance and provides search methods
 */
let searchIndex: MiniSearch<BM25Document> | null = null;
let indexedDocCount = 0;

/**
 * Build the BM25 index from file contents
 * Should be called after ingestion completes
 *
 * @param fileContents - Map of file path to content
 * @returns Number of documents indexed
 */
export const buildBM25Index = (fileContents: Map<string, string>): number => {
  // Create new MiniSearch instance with BM25-like scoring
  searchIndex = new MiniSearch<BM25Document>({
    fields: ["content", "name"], // Fields to index
    storeFields: ["id"], // Fields to return in results

    // Tokenizer: split on non-alphanumeric, camelCase, snake_case
    tokenize: (text: string) => {
      // Split on whitespace and punctuation
      const tokens = text.toLowerCase().split(/[\s\-_./\\(){}[\]<>:;,!?'"]+/);

      // Also split camelCase: "getUserById" -> ["get", "user", "by", "id"]
      const expanded: string[] = [];
      for (const token of tokens) {
        if (token.length === 0) continue;

        // Split camelCase
        const camelParts = token
          .replace(/([a-z])([A-Z])/g, "$1 $2")
          .toLowerCase()
          .split(" ");
        expanded.push(...camelParts);

        // Also keep original token for exact matches
        if (camelParts.length > 1) {
          expanded.push(token);
        }
      }

      // Filter out very short tokens and common noise
      return expanded.filter((t) => t.length > 1 && !STOP_WORDS.has(t));
    },
  });

  // Index all files
  const documents: BM25Document[] = [];

  for (const [filePath, content] of fileContents.entries()) {
    // Extract filename from path
    const name = filePath.split("/").pop() || filePath;

    documents.push({
      id: filePath,
      content: content,
      name: name,
    });
  }

  // Batch add for efficiency
  searchIndex.addAll(documents);
  indexedDocCount = documents.length;

  if (import.meta.env.DEV) {
    console.log(`📚 BM25 index built: ${indexedDocCount} documents`);
  }

  return indexedDocCount;
};

/**
 * Search the BM25 index
 *
 * @param query - Search query (keywords)
 * @param limit - Maximum results to return
 * @returns Ranked search results with file paths and scores
 */
export const searchBM25 = (
  query: string,
  limit: number = 20,
): BM25SearchResult[] => {
  if (!searchIndex) {
    return [];
  }

  // Search with fuzzy matching and prefix support
  const results = searchIndex.search(query, {
    fuzzy: 0.2,
    prefix: true,
    boost: { name: 2 }, // Boost file name matches
  });

  // Limit results and add rank
  return results.slice(0, limit).map((r, index) => ({
    filePath: r.id,
    score: r.score,
    rank: index + 1,
  }));
};

/**
 * Check if the BM25 index is ready
 */
export const isBM25Ready = (): boolean => {
  return searchIndex !== null && indexedDocCount > 0;
};

/**
 * Get index statistics
 */
export const getBM25Stats = (): {
  documentCount: number;
  termCount: number;
} => {
  if (!searchIndex) {
    return { documentCount: 0, termCount: 0 };
  }

  return {
    documentCount: indexedDocCount,
    termCount: searchIndex.termCount,
  };
};

/**
 * Clear the index (for cleanup or re-indexing)
 */
export const clearBM25Index = (): void => {
  searchIndex = null;
  indexedDocCount = 0;
};

/**
 * Common stop words to filter out (too common to be useful)
 */
const STOP_WORDS = new Set([
  // JavaScript/TypeScript keywords
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "class",
  "new",
  "this",
  "import",
  "export",
  "from",
  "default",
  "async",
  "await",
  "try",
  "catch",
  "throw",
  "typeof",
  "instanceof",
  "true",
  "false",
  "null",
  "undefined",

  // Common English stop words
  "the",
  "is",
  "at",
  "which",
  "on",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "with",
  "to",
  "of",
  "it",
  "be",
  "as",
  "by",
  "that",
  "for",
  "are",
  "was",
  "were",
]);
