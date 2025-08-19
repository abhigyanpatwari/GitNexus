/**
 * Semantic similarity service for query caching and reuse
 */

export interface SimilarityMatch {
  text: string;
  similarity: number;
  metadata?: any;
}

export interface EmbeddingVector {
  text: string;
  vector: number[];
  metadata?: any;
}

/**
 * Simple text-based similarity calculator (client-side friendly)
 * In production, you'd want to use proper embeddings from OpenAI, etc.
 */
export class TextSimilarityCalculator {
  /**
   * Calculate Jaccard similarity between two texts
   */
  static jaccardSimilarity(text1: string, text2: string): number {
    const words1 = new Set(this.tokenize(text1));
    const words2 = new Set(this.tokenize(text2));
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / union.size;
  }

  /**
   * Calculate cosine similarity using TF-IDF vectors
   */
  static cosineSimilarity(text1: string, text2: string): number {
    const tokens1 = this.tokenize(text1);
    const tokens2 = this.tokenize(text2);
    
    const allTokens = new Set([...tokens1, ...tokens2]);
    const vector1 = this.createTfIdfVector(tokens1, allTokens);
    const vector2 = this.createTfIdfVector(tokens2, allTokens);
    
    return this.cosineSimilarityVectors(vector1, vector2);
  }

  /**
   * Calculate semantic similarity using multiple methods
   */
  static semanticSimilarity(text1: string, text2: string): number {
    // Combine multiple similarity measures
    const jaccard = this.jaccardSimilarity(text1, text2);
    const cosine = this.cosineSimilarity(text1, text2);
    const levenshtein = this.normalizedLevenshtein(text1, text2);
    
    // Weighted combination
    return (jaccard * 0.3) + (cosine * 0.4) + (levenshtein * 0.3);
  }

  /**
   * Find the most similar text from a list
   */
  static findMostSimilar(
    query: string,
    candidates: string[],
    threshold: number = 0.5
  ): SimilarityMatch | null {
    let bestMatch: SimilarityMatch | null = null;
    let bestSimilarity = 0;

    for (const candidate of candidates) {
      const similarity = this.semanticSimilarity(query, candidate);
      
      if (similarity > threshold && similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = {
          text: candidate,
          similarity
        };
      }
    }

    return bestMatch;
  }

  /**
   * Find all similar texts above threshold
   */
  static findSimilar(
    query: string,
    candidates: string[],
    threshold: number = 0.5,
    maxResults: number = 10
  ): SimilarityMatch[] {
    const matches: SimilarityMatch[] = [];

    for (const candidate of candidates) {
      const similarity = this.semanticSimilarity(query, candidate);
      
      if (similarity > threshold) {
        matches.push({
          text: candidate,
          similarity
        });
      }
    }

    // Sort by similarity descending and limit results
    return matches
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, maxResults);
  }

  // Private helper methods

  private static tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(token => token.length > 2) // Filter out short words
      .filter(token => !this.isStopWord(token));
  }

  private static isStopWord(word: string): boolean {
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'have',
      'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
      'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those',
      'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them'
    ]);
    return stopWords.has(word);
  }

  private static createTfIdfVector(tokens: string[], allTokens: Set<string>): number[] {
    const vector: number[] = [];
    const tokenCount = tokens.length;
    
    for (const token of allTokens) {
      const tf = tokens.filter(t => t === token).length / tokenCount;
      vector.push(tf);
    }
    
    return vector;
  }

  private static cosineSimilarityVectors(vector1: number[], vector2: number[]): number {
    let dotProduct = 0;
    let magnitude1 = 0;
    let magnitude2 = 0;
    
    for (let i = 0; i < vector1.length; i++) {
      dotProduct += vector1[i] * vector2[i];
      magnitude1 += vector1[i] * vector1[i];
      magnitude2 += vector2[i] * vector2[i];
    }
    
    magnitude1 = Math.sqrt(magnitude1);
    magnitude2 = Math.sqrt(magnitude2);
    
    if (magnitude1 === 0 || magnitude2 === 0) {
      return 0;
    }
    
    return dotProduct / (magnitude1 * magnitude2);
  }

  private static normalizedLevenshtein(str1: string, str2: string): number {
    const matrix: number[][] = [];
    const len1 = str1.length;
    const len2 = str2.length;

    if (len1 === 0) return len2 === 0 ? 1 : 0;
    if (len2 === 0) return 0;

    // Initialize matrix
    for (let i = 0; i <= len1; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= len2; j++) {
      matrix[0][j] = j;
    }

    // Calculate distances
    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,      // deletion
          matrix[i][j - 1] + 1,      // insertion
          matrix[i - 1][j - 1] + cost // substitution
        );
      }
    }

    const maxLen = Math.max(len1, len2);
    return 1 - (matrix[len1][len2] / maxLen);
  }
}

/**
 * Enhanced similarity service with caching and optimization
 */
export class SemanticSimilarityService {
  private cache: Map<string, SimilarityMatch[]> = new Map();
  private maxCacheSize: number;

  constructor(options: { maxCacheSize?: number } = {}) {
    this.maxCacheSize = options.maxCacheSize || 1000;
  }

  /**
   * Find similar texts with caching
   */
  findSimilar(
    query: string,
    candidates: string[],
    options: {
      threshold?: number;
      maxResults?: number;
      useCache?: boolean;
    } = {}
  ): SimilarityMatch[] {
    const { threshold = 0.5, maxResults = 10, useCache = true } = options;
    
    const cacheKey = `${query}:${threshold}:${maxResults}`;
    
    // Check cache first
    if (useCache && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // Calculate similarities
    const matches = TextSimilarityCalculator.findSimilar(
      query,
      candidates,
      threshold,
      maxResults
    );

    // Cache results
    if (useCache) {
      this.cacheResults(cacheKey, matches);
    }

    return matches;
  }

  /**
   * Find the most similar text with caching
   */
  findMostSimilar(
    query: string,
    candidates: string[],
    threshold: number = 0.5,
    useCache: boolean = true
  ): SimilarityMatch | null {
    const matches = this.findSimilar(query, candidates, {
      threshold,
      maxResults: 1,
      useCache
    });

    return matches.length > 0 ? matches[0] : null;
  }

  /**
   * Batch similarity calculation for multiple queries
   */
  batchFindSimilar(
    queries: string[],
    candidates: string[],
    options: {
      threshold?: number;
      maxResults?: number;
      useCache?: boolean;
    } = {}
  ): Map<string, SimilarityMatch[]> {
    const results = new Map<string, SimilarityMatch[]>();

    for (const query of queries) {
      const matches = this.findSimilar(query, candidates, options);
      results.set(query, matches);
    }

    return results;
  }

  /**
   * Clear similarity cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    size: number;
    maxSize: number;
    hitRate: number;
  } {
    return {
      size: this.cache.size,
      maxSize: this.maxCacheSize,
      hitRate: 0 // Would need to track hits/misses for this
    };
  }

  // Private methods

  private cacheResults(key: string, results: SimilarityMatch[]): void {
    // Implement LRU eviction if cache is full
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, results);
  }
}

/**
 * Question similarity service specifically for chat history
 */
export class QuestionSimilarityService extends SemanticSimilarityService {
  /**
   * Normalize questions for better similarity matching
   */
  private normalizeQuestion(question: string): string {
    return question
      .toLowerCase()
      .replace(/[?!.]/g, '') // Remove punctuation
      .replace(/\b(what|where|when|why|how|who|which|can|could|would|should|do|does|did|is|are|was|were)\b/g, '') // Remove question words
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
  }

  /**
   * Find similar questions in chat history
   */
  findSimilarQuestions(
    currentQuestion: string,
    previousQuestions: string[],
    options: {
      threshold?: number;
      maxResults?: number;
      normalizeQuestions?: boolean;
    } = {}
  ): SimilarityMatch[] {
    const { threshold = 0.6, maxResults = 5, normalizeQuestions = true } = options;

    const queryText = normalizeQuestions 
      ? this.normalizeQuestion(currentQuestion)
      : currentQuestion;

    const candidateTexts = normalizeQuestions
      ? previousQuestions.map(q => this.normalizeQuestion(q))
      : previousQuestions;

    const matches = this.findSimilar(queryText, candidateTexts, {
      threshold,
      maxResults,
      useCache: true
    });

    // Map back to original questions if normalized
    if (normalizeQuestions) {
      return matches.map(match => {
        const originalIndex = candidateTexts.indexOf(match.text);
        return {
          ...match,
          text: previousQuestions[originalIndex]
        };
      });
    }

    return matches;
  }

  /**
   * Check if a question is similar to any previous question
   */
  isSimilarToPrevious(
    currentQuestion: string,
    previousQuestions: string[],
    threshold: number = 0.7
  ): boolean {
    const match = this.findMostSimilar(
      this.normalizeQuestion(currentQuestion),
      previousQuestions.map(q => this.normalizeQuestion(q)),
      threshold
    );

    return match !== null;
  }
}

/**
 * Default instances for easy use
 */
export const textSimilarity = new TextSimilarityCalculator();
export const semanticSimilarity = new SemanticSimilarityService();
export const questionSimilarity = new QuestionSimilarityService();
