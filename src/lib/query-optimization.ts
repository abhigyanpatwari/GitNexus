/**
 * Query optimization and learning service for improving Cypher query generation
 */

export interface QueryPerformanceMetrics {
  query: string;
  executionTime: number;
  resultCount: number;
  success: boolean;
  error?: string;
  timestamp: number;
  question: string;
  confidence: number;
}

export interface QueryPattern {
  pattern: string;
  description: string;
  examples: string[];
  performance: {
    averageExecutionTime: number;
    successRate: number;
    usageCount: number;
  };
  lastUsed: number;
}

export interface OptimizationSuggestion {
  type: 'performance' | 'accuracy' | 'pattern';
  severity: 'low' | 'medium' | 'high';
  message: string;
  originalQuery: string;
  suggestedQuery?: string;
  reasoning: string;
}

/**
 * Query optimization and learning service
 */
export class QueryOptimizationService {
  private performanceHistory: Map<string, QueryPerformanceMetrics[]> = new Map();
  private queryPatterns: Map<string, QueryPattern> = new Map();
  private maxHistorySize: number;
  private storageKey: string;

  constructor(options: {
    maxHistorySize?: number;
    storageKey?: string;
  } = {}) {
    this.maxHistorySize = options.maxHistorySize || 1000;
    this.storageKey = options.storageKey || 'gitnexus_query_optimization';
    this.loadFromStorage();
  }

  /**
   * Record query performance metrics
   */
  recordQueryPerformance(metrics: QueryPerformanceMetrics): void {
    const queryHash = this.hashQuery(metrics.query);
    
    if (!this.performanceHistory.has(queryHash)) {
      this.performanceHistory.set(queryHash, []);
    }

    const history = this.performanceHistory.get(queryHash)!;
    history.push(metrics);

    // Limit history size per query
    if (history.length > 50) {
      history.shift();
    }

    // Update query patterns
    this.updateQueryPatterns(metrics);

    // Save to storage
    this.saveToStorage();
  }

  /**
   * Get performance statistics for a query
   */
  getQueryPerformance(query: string): {
    averageExecutionTime: number;
    successRate: number;
    totalExecutions: number;
    lastExecution?: Date;
    trend: 'improving' | 'degrading' | 'stable';
  } | null {
    const queryHash = this.hashQuery(query);
    const history = this.performanceHistory.get(queryHash);

    if (!history || history.length === 0) {
      return null;
    }

    const successfulExecutions = history.filter(h => h.success);
    const averageExecutionTime = successfulExecutions.length > 0
      ? successfulExecutions.reduce((sum, h) => sum + h.executionTime, 0) / successfulExecutions.length
      : 0;

    const successRate = successfulExecutions.length / history.length;
    const lastExecution = history.length > 0 
      ? new Date(history[history.length - 1].timestamp)
      : undefined;

    // Calculate trend (comparing recent vs older performance)
    const trend = this.calculatePerformanceTrend(history);

    return {
      averageExecutionTime,
      successRate,
      totalExecutions: history.length,
      lastExecution,
      trend
    };
  }

  /**
   * Generate optimization suggestions for a query
   */
  generateOptimizationSuggestions(
    query: string,
    executionTime?: number,
    resultCount?: number
  ): OptimizationSuggestion[] {
    const suggestions: OptimizationSuggestion[] = [];

    // Performance-based suggestions
    if (executionTime && executionTime > 1000) {
      suggestions.push({
        type: 'performance',
        severity: 'high',
        message: 'Query execution time is high (>1s). Consider optimizing.',
        originalQuery: query,
        suggestedQuery: this.optimizeSlowQuery(query),
        reasoning: 'Long execution times can impact user experience. Consider using indexes, limiting results, or simplifying the query.'
      });
    }

    // Pattern-based suggestions
    const patternSuggestions = this.analyzeQueryPatterns(query);
    suggestions.push(...patternSuggestions);

    // Result count suggestions
    if (resultCount !== undefined) {
      if (resultCount === 0) {
        suggestions.push({
          type: 'accuracy',
          severity: 'medium',
          message: 'Query returned no results. Consider broadening the search criteria.',
          originalQuery: query,
          reasoning: 'Empty results may indicate overly specific filters or incorrect node/relationship names.'
        });
      } else if (resultCount > 1000) {
        suggestions.push({
          type: 'performance',
          severity: 'medium',
          message: 'Query returned many results. Consider adding LIMIT clause.',
          originalQuery: query,
          suggestedQuery: this.addLimitToQuery(query, 100),
          reasoning: 'Large result sets can impact performance and are often not necessary for analysis.'
        });
      }
    }

    return suggestions;
  }

  /**
   * Learn from successful query patterns
   */
  learnFromSuccessfulQuery(
    query: string,
    question: string,
    executionTime: number,
    resultCount: number
  ): void {
    const pattern = this.extractQueryPattern(query);
    
    if (!this.queryPatterns.has(pattern)) {
      this.queryPatterns.set(pattern, {
        pattern,
        description: this.generatePatternDescription(pattern),
        examples: [],
        performance: {
          averageExecutionTime: executionTime,
          successRate: 1.0,
          usageCount: 1
        },
        lastUsed: Date.now()
      });
    } else {
      const existing = this.queryPatterns.get(pattern)!;
      existing.performance.averageExecutionTime = 
        (existing.performance.averageExecutionTime * existing.performance.usageCount + executionTime) / 
        (existing.performance.usageCount + 1);
      existing.performance.usageCount++;
      existing.lastUsed = Date.now();
    }

    // Add example if not already present
    const patternData = this.queryPatterns.get(pattern)!;
    if (!patternData.examples.includes(query) && patternData.examples.length < 5) {
      patternData.examples.push(query);
    }

    this.saveToStorage();
  }

  /**
   * Get best performing query patterns
   */
  getBestPerformingPatterns(limit: number = 10): QueryPattern[] {
    return Array.from(this.queryPatterns.values())
      .filter(pattern => pattern.performance.usageCount >= 3) // Only patterns used multiple times
      .sort((a, b) => {
        // Sort by combination of success rate and performance
        const scoreA = a.performance.successRate * (1000 / Math.max(a.performance.averageExecutionTime, 1));
        const scoreB = b.performance.successRate * (1000 / Math.max(b.performance.averageExecutionTime, 1));
        return scoreB - scoreA;
      })
      .slice(0, limit);
  }

  /**
   * Suggest similar successful queries for a given question
   */
  suggestSimilarSuccessfulQueries(
    question: string,
    limit: number = 3
  ): Array<{
    query: string;
    similarity: number;
    performance: QueryPerformanceMetrics;
  }> {
    const suggestions: Array<{
      query: string;
      similarity: number;
      performance: QueryPerformanceMetrics;
    }> = [];

    // Simple keyword-based similarity for now
    const questionWords = question.toLowerCase().split(/\s+/);

    for (const [queryHash, history] of this.performanceHistory) {
      const successfulExecutions = history.filter(h => h.success && h.resultCount > 0);
      
      if (successfulExecutions.length > 0) {
        const bestExecution = successfulExecutions.reduce((best, current) => 
          current.executionTime < best.executionTime ? current : best
        );

        // Calculate similarity based on question keywords
        const questionSimilarity = this.calculateQuestionSimilarity(
          question,
          bestExecution.question
        );

        if (questionSimilarity > 0.3) {
          suggestions.push({
            query: bestExecution.query,
            similarity: questionSimilarity,
            performance: bestExecution
          });
        }
      }
    }

    return suggestions
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  /**
   * Get optimization statistics
   */
  getOptimizationStats(): {
    totalQueries: number;
    uniqueQueries: number;
    averageExecutionTime: number;
    successRate: number;
    topPatterns: QueryPattern[];
    recentTrends: {
      improving: number;
      degrading: number;
      stable: number;
    };
  } {
    let totalExecutions = 0;
    let totalExecutionTime = 0;
    let successfulExecutions = 0;
    const trends = { improving: 0, degrading: 0, stable: 0 };

    for (const history of this.performanceHistory.values()) {
      totalExecutions += history.length;
      
      for (const execution of history) {
        totalExecutionTime += execution.executionTime;
        if (execution.success) {
          successfulExecutions++;
        }
      }

      // Calculate trend for this query
      const trend = this.calculatePerformanceTrend(history);
      trends[trend]++;
    }

    return {
      totalQueries: totalExecutions,
      uniqueQueries: this.performanceHistory.size,
      averageExecutionTime: totalExecutions > 0 ? totalExecutionTime / totalExecutions : 0,
      successRate: totalExecutions > 0 ? successfulExecutions / totalExecutions : 0,
      topPatterns: this.getBestPerformingPatterns(5),
      recentTrends: trends
    };
  }

  /**
   * Clear optimization data
   */
  clearOptimizationData(): void {
    this.performanceHistory.clear();
    this.queryPatterns.clear();
    localStorage.removeItem(this.storageKey);
  }

  // Private helper methods

  private hashQuery(query: string): string {
    // Simple hash function for query normalization
    return btoa(query.replace(/\s+/g, ' ').trim().toLowerCase())
      .replace(/[^a-zA-Z0-9]/g, '')
      .substring(0, 16);
  }

  private updateQueryPatterns(metrics: QueryPerformanceMetrics): void {
    const pattern = this.extractQueryPattern(metrics.query);
    
    if (this.queryPatterns.has(pattern)) {
      const existing = this.queryPatterns.get(pattern)!;
      const newUsageCount = existing.performance.usageCount + 1;
      const newSuccessRate = 
        (existing.performance.successRate * existing.performance.usageCount + (metrics.success ? 1 : 0)) / 
        newUsageCount;
      
      existing.performance.usageCount = newUsageCount;
      existing.performance.successRate = newSuccessRate;
      existing.lastUsed = metrics.timestamp;
    }
  }

  private extractQueryPattern(query: string): string {
    // Extract the general pattern from a Cypher query
    return query
      .replace(/\{[^}]*\}/g, '{...}') // Replace property filters
      .replace(/'[^']*'/g, "'...'") // Replace string literals
      .replace(/\b\d+\b/g, 'N') // Replace numbers
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
  }

  private generatePatternDescription(pattern: string): string {
    // Generate human-readable description of query pattern
    if (pattern.includes('MATCH') && pattern.includes('RETURN')) {
      if (pattern.includes('*')) {
        return 'Variable-length path traversal query';
      } else if (pattern.includes('COUNT')) {
        return 'Aggregation counting query';
      } else if (pattern.includes('COLLECT')) {
        return 'Collection aggregation query';
      } else {
        return 'Basic node/relationship matching query';
      }
    }
    return 'Custom query pattern';
  }

  private calculatePerformanceTrend(history: QueryPerformanceMetrics[]): 'improving' | 'degrading' | 'stable' {
    if (history.length < 4) return 'stable';

    const recent = history.slice(-3);
    const older = history.slice(-6, -3);

    if (older.length === 0) return 'stable';

    const recentAvg = recent.reduce((sum, h) => sum + h.executionTime, 0) / recent.length;
    const olderAvg = older.reduce((sum, h) => sum + h.executionTime, 0) / older.length;

    const improvement = (olderAvg - recentAvg) / olderAvg;

    if (improvement > 0.1) return 'improving';
    if (improvement < -0.1) return 'degrading';
    return 'stable';
  }

  private analyzeQueryPatterns(query: string): OptimizationSuggestion[] {
    const suggestions: OptimizationSuggestion[] = [];

    // Check for common anti-patterns
    if (query.includes('MATCH ()') && !query.includes('LIMIT')) {
      suggestions.push({
        type: 'performance',
        severity: 'high',
        message: 'Avoid matching all nodes without filters. Add specific labels or properties.',
        originalQuery: query,
        reasoning: 'Matching all nodes can be very expensive on large graphs.'
      });
    }

    if (query.includes('*1..') && query.includes('*1..10')) {
      suggestions.push({
        type: 'performance',
        severity: 'medium',
        message: 'Long variable-length paths can be expensive. Consider reducing the maximum depth.',
        originalQuery: query,
        suggestedQuery: query.replace(/\*1\.\.\d+/, '*1..5'),
        reasoning: 'Limiting path depth reduces computational complexity.'
      });
    }

    if (!query.includes('LIMIT') && !query.includes('COUNT')) {
      suggestions.push({
        type: 'performance',
        severity: 'low',
        message: 'Consider adding a LIMIT clause to control result size.',
        originalQuery: query,
        suggestedQuery: this.addLimitToQuery(query, 100),
        reasoning: 'Limiting results improves performance and is often sufficient for analysis.'
      });
    }

    return suggestions;
  }

  private optimizeSlowQuery(query: string): string {
    let optimized = query;

    // Add LIMIT if not present
    if (!optimized.includes('LIMIT')) {
      optimized = this.addLimitToQuery(optimized, 50);
    }

    // Reduce variable-length path depth
    optimized = optimized.replace(/\*1\.\.\d+/g, '*1..3');

    return optimized;
  }

  private addLimitToQuery(query: string, limit: number): string {
    if (query.includes('LIMIT')) {
      return query;
    }

    // Add LIMIT before the last RETURN statement
    const returnIndex = query.lastIndexOf('RETURN');
    if (returnIndex !== -1) {
      const beforeReturn = query.substring(0, returnIndex);
      const afterReturn = query.substring(returnIndex);
      return `${beforeReturn}${afterReturn} LIMIT ${limit}`;
    }

    return `${query} LIMIT ${limit}`;
  }

  private calculateQuestionSimilarity(question1: string, question2: string): number {
    const words1 = new Set(question1.toLowerCase().split(/\s+/));
    const words2 = new Set(question2.toLowerCase().split(/\s+/));
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / union.size;
  }

  private saveToStorage(): void {
    try {
      const data = {
        performanceHistory: Array.from(this.performanceHistory.entries()),
        queryPatterns: Array.from(this.queryPatterns.entries()),
        timestamp: Date.now()
      };
      localStorage.setItem(this.storageKey, JSON.stringify(data));
    } catch (error) {
      console.warn('Failed to save optimization data:', error);
    }
  }

  private loadFromStorage(): void {
    try {
      const data = localStorage.getItem(this.storageKey);
      if (data) {
        const parsed = JSON.parse(data);
        this.performanceHistory = new Map(parsed.performanceHistory || []);
        this.queryPatterns = new Map(parsed.queryPatterns || []);
      }
    } catch (error) {
      console.warn('Failed to load optimization data:', error);
    }
  }
}

/**
 * Default query optimization service instance
 */
export const queryOptimization = new QueryOptimizationService();
