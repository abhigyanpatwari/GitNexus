import { LRUCache } from 'lru-cache';
import Parser from 'web-tree-sitter';

export interface CacheOptions {
  max?: number;
  ttl?: number;
  maxSize?: number;
  allowStale?: boolean;
  updateAgeOnGet?: boolean;
}

export interface ParsedDefinition {
  name: string;
  type: 'function' | 'class' | 'method' | 'variable' | 'import' | 'interface' | 'type' | 'decorator';
  startLine: number;
  endLine?: number;
  parameters?: string[];
  returnType?: string;
  accessibility?: 'public' | 'private' | 'protected';
  isStatic?: boolean;
  isAsync?: boolean;
  parentClass?: string;
  decorators?: string[];
  extends?: string[];
  implements?: string[];
  importPath?: string;
  exportType?: 'named' | 'default' | 'namespace';
  docstring?: string;
}

export interface ParsedFileCache {
  ast: Parser.Tree;
  definitions: ParsedDefinition[];
  language: string;
  lastModified: number;
  fileSize: number;
}

export interface QueryResultCache {
  query: string;
  results: Parser.QueryMatch[];
  timestamp: number;
}

export class LRUCacheService {
  private static instance: LRUCacheService;
  
  // Cache for parsed files (AST and definitions)
  private fileCache: LRUCache<string, ParsedFileCache>;
  
  // Cache for Tree-sitter query results
  private queryCache: LRUCache<string, QueryResultCache>;
  
  // Cache for language parsers
  private parserCache: LRUCache<string, Parser.Language>;

  // Hit rate tracking
  private fileCacheHits = 0;
  private fileCacheMisses = 0;
  private queryCacheHits = 0;
  private queryCacheMisses = 0;
  private parserCacheHits = 0;
  private parserCacheMisses = 0;

  private constructor(options: CacheOptions = {}) {
    const defaultOptions = {
      max: 500, // Maximum number of items
      ttl: 1000 * 60 * 30, // 30 minutes TTL
      maxSize: 100 * 1024 * 1024, // 100MB max size
      allowStale: false,
      updateAgeOnGet: true
    };

    const cacheOptions = { ...defaultOptions, ...options };

    this.fileCache = new LRUCache<string, ParsedFileCache>({
      ...cacheOptions,
      max: options.max || 200, // Smaller cache for files
      ttl: options.ttl || 1000 * 60 * 60, // 1 hour for parsed files
      sizeCalculation: (value) => {
        // Estimate size based on file size and AST complexity
        return value.fileSize + (value.definitions.length * 100);
      }
    });

    this.queryCache = new LRUCache<string, QueryResultCache>({
      ...cacheOptions,
      max: options.max || 1000, // Larger cache for queries
      ttl: options.ttl || 1000 * 60 * 15, // 15 minutes for query results
      sizeCalculation: (value) => {
        // Estimate size based on query length and result count
        return value.query.length + (value.results.length * 50);
      }
    });

    this.parserCache = new LRUCache<string, Parser.Language>({
      ...cacheOptions,
      max: 10, // Small cache for parsers
      ttl: 1000 * 60 * 60 * 24, // 24 hours for parsers
      sizeCalculation: () => 1024 * 1024 // 1MB per parser
    });
  }

  public static getInstance(options?: CacheOptions): LRUCacheService {
    if (!LRUCacheService.instance) {
      LRUCacheService.instance = new LRUCacheService(options);
    }
    return LRUCacheService.instance;
  }

  // File cache methods
  public getParsedFile(filePath: string): ParsedFileCache | undefined {
    const result = this.fileCache.get(filePath);
    if (result) {
      this.fileCacheHits++;
    } else {
      this.fileCacheMisses++;
    }
    return result;
  }

  public setParsedFile(filePath: string, data: ParsedFileCache): void {
    this.fileCache.set(filePath, data);
  }

  public hasParsedFile(filePath: string): boolean {
    return this.fileCache.has(filePath);
  }

  public deleteParsedFile(filePath: string): boolean {
    return this.fileCache.delete(filePath);
  }

  // Query cache methods
  public getQueryResult(cacheKey: string): QueryResultCache | undefined {
    const result = this.queryCache.get(cacheKey);
    if (result) {
      this.queryCacheHits++;
    } else {
      this.queryCacheMisses++;
    }
    return result;
  }

  public setQueryResult(cacheKey: string, data: QueryResultCache): void {
    this.queryCache.set(cacheKey, data);
  }

  public hasQueryResult(cacheKey: string): boolean {
    return this.queryCache.has(cacheKey);
  }

  public deleteQueryResult(cacheKey: string): boolean {
    return this.queryCache.delete(cacheKey);
  }

  // Parser cache methods
  public getParser(language: string): Parser.Language | undefined {
    const result = this.parserCache.get(language);
    if (result) {
      this.parserCacheHits++;
    } else {
      this.parserCacheMisses++;
    }
    return result;
  }

  public setParser(language: string, parser: Parser.Language): void {
    this.parserCache.set(language, parser);
  }

  public hasParser(language: string): boolean {
    return this.parserCache.has(language);
  }

  public deleteParser(language: string): boolean {
    return this.parserCache.delete(language);
  }

  // Cache management methods
  public clearAll(): void {
    this.fileCache.clear();
    this.queryCache.clear();
    this.parserCache.clear();
    this.resetHitRateCounters();
  }

  private resetHitRateCounters(): void {
    this.fileCacheHits = 0;
    this.fileCacheMisses = 0;
    this.queryCacheHits = 0;
    this.queryCacheMisses = 0;
    this.parserCacheHits = 0;
    this.parserCacheMisses = 0;
  }

  public clearFileCache(): void {
    this.fileCache.clear();
  }

  public clearQueryCache(): void {
    this.queryCache.clear();
  }

  public clearParserCache(): void {
    this.parserCache.clear();
  }

  // Statistics methods
  public getStats() {
    return {
      fileCache: {
        size: this.fileCache.size,
        max: this.fileCache.max,
        ttl: this.fileCache.ttl,
        calculatedSize: this.fileCache.calculatedSize
      },
      queryCache: {
        size: this.queryCache.size,
        max: this.queryCache.max,
        ttl: this.queryCache.ttl,
        calculatedSize: this.queryCache.calculatedSize
      },
      parserCache: {
        size: this.parserCache.size,
        max: this.parserCache.max,
        ttl: this.parserCache.ttl,
        calculatedSize: this.parserCache.calculatedSize
      }
    };
  }

  // Utility methods
  public generateFileCacheKey(filePath: string, contentHash?: string): string {
    return contentHash ? `${filePath}:${contentHash}` : filePath;
  }

  public generateQueryCacheKey(language: string, query: string): string {
    return `${language}:${query}`;
  }

  public getCacheHitRate(): { fileCache: number; queryCache: number; parserCache: number } {
    const fileCacheTotal = this.fileCacheHits + this.fileCacheMisses;
    const queryCacheTotal = this.queryCacheHits + this.queryCacheMisses;
    const parserCacheTotal = this.parserCacheHits + this.parserCacheMisses;

    return {
      fileCache: fileCacheTotal > 0 ? this.fileCacheHits / fileCacheTotal : 0,
      queryCache: queryCacheTotal > 0 ? this.queryCacheHits / queryCacheTotal : 0,
      parserCache: parserCacheTotal > 0 ? this.parserCacheHits / parserCacheTotal : 0
    };
  }

  public getDetailedHitRateStats(): {
    fileCache: { hits: number; misses: number; total: number; rate: number };
    queryCache: { hits: number; misses: number; total: number; rate: number };
    parserCache: { hits: number; misses: number; total: number; rate: number };
  } {
    const fileCacheTotal = this.fileCacheHits + this.fileCacheMisses;
    const queryCacheTotal = this.queryCacheHits + this.queryCacheMisses;
    const parserCacheTotal = this.parserCacheHits + this.parserCacheMisses;

    return {
      fileCache: {
        hits: this.fileCacheHits,
        misses: this.fileCacheMisses,
        total: fileCacheTotal,
        rate: fileCacheTotal > 0 ? this.fileCacheHits / fileCacheTotal : 0
      },
      queryCache: {
        hits: this.queryCacheHits,
        misses: this.queryCacheMisses,
        total: queryCacheTotal,
        rate: queryCacheTotal > 0 ? this.queryCacheHits / queryCacheTotal : 0
      },
      parserCache: {
        hits: this.parserCacheHits,
        misses: this.parserCacheMisses,
        total: parserCacheTotal,
        rate: parserCacheTotal > 0 ? this.parserCacheHits / parserCacheTotal : 0
      }
    };
  }
}
