import { ChatSessionManager, LocalStorageChatHistory, type ChatHistoryMetadata } from './chat-history.ts';

export interface CachedQuery {
  question: string;
  cypherQuery: string;
  confidence: number;
  executionTime: number;
  resultCount: number;
  timestamp: number;
  success: boolean;
}

export interface QuerySuggestion {
  cypherQuery: string;
  confidence: number;
  similarity: number;
  sourceQuestion: string;
  executionTime: number;
}

export interface QueryCacheStats {
  totalQueries: number;
  successfulQueries: number;
  averageExecutionTime: number;
  averageConfidence: number;
  cacheHitRate: number;
  lastUpdated: number;
}

/**
 * Query cache service that learns from previous queries and suggests similar ones
 */
export class QueryCacheService {
  private static instance: QueryCacheService;
  private cache: Map<string, CachedQuery> = new Map();
  private questionEmbeddings: Map<string, number[]> = new Map();
  private maxCacheSize: number;
  private storageKey: string;

  private constructor(options: {
    maxCacheSize?: number;
    storageKey?: string;
  } = {}) {
    this.maxCacheSize = options.maxCacheSize || 1000;
    this.storageKey = options.storageKey || 'gitnexus_query_cache';
    this.loadFromStorage();
  }

  static getInstance(options?: {
    maxCacheSize?: number;
    storageKey?: string;
  }): QueryCacheService {
    if (!QueryCacheService.instance) {
      QueryCacheService.instance = new QueryCacheService(options);
    }
    return QueryCacheService.instance;
  }

  /**
   * Add a query to the cache
   */
  addQuery(
    question: string,
    cypherQuery: string,
    confidence: number,
    executionTime: number,
    resultCount: number,
    success: boolean = true
  ): void {
    const queryHash = this.hashQuestion(question);
    
    const cachedQuery: CachedQuery = {
      question,
      cypherQuery,
      confidence,
      executionTime,
      resultCount,
      timestamp: Date.now(),
      success
    };

    this.cache.set(queryHash, cachedQuery);
    
    // Maintain cache size
    if (this.cache.size > this.maxCacheSize) {
      this.evictOldest();
    }

    this.saveToStorage();
  }

  /**
   * Find similar queries for a given question
   */
  findSimilarQueries(
    question: string,
    options: {
      minSimilarity?: number;
      maxResults?: number;
      minConfidence?: number;
    } = {}
  ): QuerySuggestion[] {
    const {
      minSimilarity = 0.7,
      maxResults = 5,
      minConfidence = 0.6
    } = options;

    const suggestions: QuerySuggestion[] = [];

    for (const [hash, cachedQuery] of this.cache.entries()) {
      if (!cachedQuery.success || cachedQuery.confidence < minConfidence) {
        continue;
      }

      const similarity = this.calculateSimilarity(question, cachedQuery.question);
      
      if (similarity >= minSimilarity) {
        suggestions.push({
          cypherQuery: cachedQuery.cypherQuery,
          confidence: cachedQuery.confidence,
          similarity,
          sourceQuestion: cachedQuery.question,
          executionTime: cachedQuery.executionTime
        });
      }
    }

    // Sort by similarity and confidence
    suggestions.sort((a, b) => {
      const scoreA = a.similarity * a.confidence;
      const scoreB = b.similarity * b.confidence;
      return scoreB - scoreA;
    });

    return suggestions.slice(0, maxResults);
  }

  /**
   * Get the best query for a question
   */
  getBestQuery(question: string): CachedQuery | null {
    const suggestions = this.findSimilarQueries(question, {
      minSimilarity: 0.8,
      maxResults: 1,
      minConfidence: 0.7
    });

    if (suggestions.length === 0) {
      return null;
    }

    const suggestion = suggestions[0];
    const queryHash = this.hashQuestion(suggestion.sourceQuestion);
    return this.cache.get(queryHash) || null;
  }

  /**
   * Load queries from chat history
   */
  async loadFromChatHistory(): Promise<void> {
    try {
      const sessions = ChatSessionManager.getAllSessions();
      
      for (const session of sessions) {
        const history = new LocalStorageChatHistory(session.id);
        const messages = await history.getMessages();
        
        for (const message of messages) {
          const metadata = message.additional_kwargs?.metadata as ChatHistoryMetadata;
          
          if (metadata?.cypherQuery && metadata?.executionTime !== undefined) {
            // Determine if this was a successful query based on confidence
            const success = (metadata.confidence || 0) > 0.5;
            
            this.addQuery(
              message.content.toString(),
              metadata.cypherQuery,
              metadata.confidence || 0.5,
              metadata.executionTime,
              0, // We don't have result count in metadata
              success
            );
          }
        }
      }
    } catch (error) {
      console.error('Failed to load queries from chat history:', error);
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): QueryCacheStats {
    const queries = Array.from(this.cache.values());
    const successfulQueries = queries.filter(q => q.success);
    
    const totalExecutionTime = successfulQueries.reduce((sum, q) => sum + q.executionTime, 0);
    const totalConfidence = successfulQueries.reduce((sum, q) => sum + q.confidence, 0);
    
    return {
      totalQueries: queries.length,
      successfulQueries: successfulQueries.length,
      averageExecutionTime: successfulQueries.length > 0 ? totalExecutionTime / successfulQueries.length : 0,
      averageConfidence: successfulQueries.length > 0 ? totalConfidence / successfulQueries.length : 0,
      cacheHitRate: 0, // Would need to track hits/misses
      lastUpdated: Date.now()
    };
  }

  /**
   * Clear the cache
   */
  clear(): void {
    this.cache.clear();
    this.questionEmbeddings.clear();
    this.saveToStorage();
  }

  /**
   * Export cache data
   */
  export(): CachedQuery[] {
    return Array.from(this.cache.values());
  }

  /**
   * Import cache data
   */
  import(queries: CachedQuery[]): void {
    this.cache.clear();
    
    for (const query of queries) {
      const hash = this.hashQuestion(query.question);
      this.cache.set(hash, query);
    }
    
    this.saveToStorage();
  }

  // Private helper methods

  private hashQuestion(question: string): string {
    // Simple hash function - in production, you might want a more sophisticated approach
    return question.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  private calculateSimilarity(question1: string, question2: string): number {
    const words1 = new Set(question1.toLowerCase().split(/\s+/));
    const words2 = new Set(question2.toLowerCase().split(/\s+/));
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / union.size;
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, query] of this.cache.entries()) {
      if (query.timestamp < oldestTime) {
        oldestTime = query.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  private saveToStorage(): void {
    try {
      const data = {
        queries: Array.from(this.cache.entries()),
        timestamp: Date.now()
      };
      localStorage.setItem(this.storageKey, JSON.stringify(data));
    } catch (error) {
      console.error('Failed to save query cache:', error);
    }
  }

  private loadFromStorage(): void {
    try {
      const data = localStorage.getItem(this.storageKey);
      if (data) {
        const parsed = JSON.parse(data);
        this.cache.clear();
        
        for (const [key, query] of parsed.queries) {
          this.cache.set(key, query as CachedQuery);
        }
      }
    } catch (error) {
      console.error('Failed to load query cache:', error);
    }
  }
}

/**
 * Enhanced query cache with learning capabilities
 */
export class LearningQueryCache extends QueryCacheService {
  private queryPatterns: Map<string, {
    pattern: string;
    examples: string[];
    successRate: number;
    averageExecutionTime: number;
    usageCount: number;
  }> = new Map();

  /**
   * Learn from a successful query
   */
  learnFromQuery(
    question: string,
    cypherQuery: string,
    executionTime: number,
    success: boolean
  ): void {
    super.addQuery(question, cypherQuery, success ? 0.8 : 0.3, executionTime, 0, success);
    
    if (success) {
      const pattern = this.extractQueryPattern(cypherQuery);
      this.updateQueryPattern(pattern, question, executionTime);
    }
  }

  /**
   * Get query suggestions based on learned patterns
   */
  getPatternSuggestions(question: string): QuerySuggestion[] {
    const suggestions: QuerySuggestion[] = [];
    
    for (const [pattern, patternData] of this.queryPatterns.entries()) {
      if (patternData.successRate > 0.7) {
        // Find the best example for this pattern
        const bestExample = patternData.examples[0];
        if (bestExample) {
          const similarity = this.calculateSimilarity(question, bestExample);
          
          if (similarity > 0.6) {
            suggestions.push({
              cypherQuery: pattern,
              confidence: patternData.successRate,
              similarity,
              sourceQuestion: bestExample,
              executionTime: patternData.averageExecutionTime
            });
          }
        }
      }
    }

    return suggestions.sort((a, b) => b.confidence - a.confidence);
  }

  private extractQueryPattern(cypherQuery: string): string {
    // Extract the basic pattern by replacing specific values with placeholders
    return cypherQuery
      .replace(/['"][^'"]*['"]/g, '?') // Replace strings with ?
      .replace(/\d+/g, '?') // Replace numbers with ?
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
  }

  private updateQueryPattern(
    pattern: string,
    question: string,
    executionTime: number
  ): void {
    if (!this.queryPatterns.has(pattern)) {
      this.queryPatterns.set(pattern, {
        pattern,
        examples: [question],
        successRate: 1.0,
        averageExecutionTime: executionTime,
        usageCount: 1
      });
    } else {
      const patternData = this.queryPatterns.get(pattern)!;
      patternData.examples.push(question);
      patternData.usageCount++;
      patternData.averageExecutionTime = 
        (patternData.averageExecutionTime * (patternData.usageCount - 1) + executionTime) / 
        patternData.usageCount;
      
      // Keep only the most recent examples
      if (patternData.examples.length > 5) {
        patternData.examples = patternData.examples.slice(-5);
      }
    }
  }
}
