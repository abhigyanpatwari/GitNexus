/**
 * LRU Cache Test Suite
 * Tests the LRU cache implementation for the parsing processor
 */

import { LRUCacheService } from './lru-cache-service.js';

/**
 * Test basic LRU cache functionality
 */
export async function testLRUCacheBasic(): Promise<void> {
  console.log('🧪 Testing Basic LRU Cache Functionality...');

  const cache = LRUCacheService.getInstance();

  try {
    // Test file cache
    const testFileData = {
      ast: { type: 'program', body: [] },
      definitions: [{ name: 'testFunction', type: 'function' }],
      language: 'typescript',
      lastModified: Date.now(),
      fileSize: 1024
    };

    cache.setParsedFile('test.ts', testFileData);
    const retrieved = cache.getParsedFile('test.ts');
    
    if (retrieved && retrieved.definitions.length === 1) {
      console.log('✅ File cache test passed');
    } else {
      console.log('❌ File cache test failed');
    }

    // Test query cache
    const testQueryData = {
      query: '(function_declaration) @function',
      results: [{ captures: [{ node: { text: 'test' } }] }],
      timestamp: Date.now()
    };

    cache.setQueryResult('typescript:(function_declaration) @function', testQueryData);
    const queryResult = cache.getQueryResult('typescript:(function_declaration) @function');
    
    if (queryResult && queryResult.results.length === 1) {
      console.log('✅ Query cache test passed');
    } else {
      console.log('❌ Query cache test failed');
    }

    // Test parser cache
    const testParser = { name: 'typescript', version: '1.0' };
    cache.setParser('typescript', testParser);
    const parser = cache.getParser('typescript');
    
    if (parser && parser.name === 'typescript') {
      console.log('✅ Parser cache test passed');
    } else {
      console.log('❌ Parser cache test failed');
    }

    // Test cache statistics
    const stats = cache.getStats();
    console.log('✅ Cache statistics:', stats);

    // Test cache hit rate
    const hitRate = cache.getCacheHitRate();
    console.log('✅ Cache hit rates:', hitRate);

    console.log('✅ Basic LRU cache test completed successfully');

  } catch (error) {
    console.error('❌ Basic LRU cache test failed:', error);
    throw error;
  }
}

/**
 * Test cache eviction (LRU behavior)
 */
export async function testLRUCacheEviction(): Promise<void> {
  console.log('🧪 Testing LRU Cache Eviction...');

  const cache = LRUCacheService.getInstance({
    max: 3, // Small cache to test eviction
    ttl: 1000 * 60 * 5 // 5 minutes
  });

  try {
    // Fill the cache
    for (let i = 0; i < 5; i++) {
      cache.setParsedFile(`file${i}.ts`, {
        ast: { type: 'program' },
        definitions: [],
        language: 'typescript',
        lastModified: Date.now(),
        fileSize: 100
      });
    }

    // Check that only the last 3 items remain
    const stats = cache.getStats();
    if (stats.fileCache.size <= 3) {
      console.log('✅ Cache eviction test passed');
    } else {
      console.log('❌ Cache eviction test failed');
    }

    console.log('✅ LRU cache eviction test completed successfully');

  } catch (error) {
    console.error('❌ LRU cache eviction test failed:', error);
    throw error;
  }
}

/**
 * Test cache key generation
 */
export function testCacheKeyGeneration(): void {
  console.log('🧪 Testing Cache Key Generation...');

  const cache = LRUCacheService.getInstance();

  try {
    // Test file cache key generation
    const fileKey1 = cache.generateFileCacheKey('test.ts');
    const fileKey2 = cache.generateFileCacheKey('test.ts', 'abc123');
    
    if (fileKey1 === 'test.ts' && fileKey2 === 'test.ts:abc123') {
      console.log('✅ File cache key generation test passed');
    } else {
      console.log('❌ File cache key generation test failed');
    }

    // Test query cache key generation
    const queryKey = cache.generateQueryCacheKey('typescript', '(function_declaration) @function');
    
    if (queryKey === 'typescript:(function_declaration) @function') {
      console.log('✅ Query cache key generation test passed');
    } else {
      console.log('❌ Query cache key generation test failed');
    }

    console.log('✅ Cache key generation test completed successfully');

  } catch (error) {
    console.error('❌ Cache key generation test failed:', error);
    throw error;
  }
}

/**
 * Run all LRU cache tests
 */
export async function runLRUCacheTests(): Promise<void> {
  console.log('🚀 Starting LRU Cache Test Suite...');

  try {
    testCacheKeyGeneration();
    await testLRUCacheBasic();
    await testLRUCacheEviction();

    console.log('🎉 All LRU cache tests completed successfully!');

  } catch (error) {
    console.error('❌ LRU cache test suite failed:', error);
    throw error;
  }
}

// Make functions available globally for browser testing
if (typeof window !== 'undefined') {
  (window as any).testLRUCacheBasic = testLRUCacheBasic;
  (window as any).testLRUCacheEviction = testLRUCacheEviction;
  (window as any).testCacheKeyGeneration = testCacheKeyGeneration;
  (window as any).runLRUCacheTests = runLRUCacheTests;
}
