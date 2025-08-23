/**
 * TEMPORARY WASM VERIFICATION TESTS
 * These tests verify that Tree-sitter WASM files are loading and working correctly
 * DELETE THIS FILE after confirming everything works
 */

import { 
  initTreeSitter, 
  loadPythonParser, 
  loadJavaScriptParser, 
  loadTypeScriptParser 
} from '../core/tree-sitter/parser-loader.js';
import Parser from 'web-tree-sitter';
import { PYTHON_QUERIES, TYPESCRIPT_QUERIES } from '../core/ingestion/tree-sitter-queries';

describe('🔍 WASM Verification Tests (TEMPORARY)', () => {
  let parser: Parser;
  
  beforeAll(async () => {
    console.log('🧪 Starting WASM verification tests...');
  });

  afterAll(() => {
    console.log('✅ WASM verification tests completed');
  });

  describe('Main Thread Tree-sitter Initialization', () => {
    it('should initialize Tree-sitter successfully', async () => {
      parser = await initTreeSitter();
      expect(parser).toBeDefined();
      expect(parser).toBeInstanceOf(Parser);
      console.log('✅ Tree-sitter main thread initialized successfully');
    });

    it('should load Python WASM parser', async () => {
      const pythonLang = await loadPythonParser();
      expect(pythonLang).toBeDefined();
      expect(typeof pythonLang.query).toBe('function');
      console.log('✅ Python WASM parser loaded successfully');
    });

    it('should load JavaScript WASM parser', async () => {
      const jsLang = await loadJavaScriptParser();
      expect(jsLang).toBeDefined();
      expect(typeof jsLang.query).toBe('function');
      console.log('✅ JavaScript WASM parser loaded successfully');
    });

    it('should load TypeScript WASM parser', async () => {
      const tsLang = await loadTypeScriptParser();
      expect(tsLang).toBeDefined();
      expect(typeof tsLang.query).toBe('function');
      console.log('✅ TypeScript WASM parser loaded successfully');
    });
  });

  describe('Python WASM Parsing Verification', () => {
    let pythonLang: Parser.Language;

    beforeAll(async () => {
      pythonLang = await loadPythonParser();
      parser.setLanguage(pythonLang);
    });

    it('should parse simple Python function', () => {
      const pythonCode = `
def test_function(param1, param2):
    """Test function docstring"""
    return param1 + param2

class TestClass:
    def method_one(self):
        pass
    
    async def async_method(self):
        return "async result"

variable_assignment = "test value"
`;

      const tree = parser.parse(pythonCode);
      expect(tree).toBeDefined();
      expect(tree.rootNode).toBeDefined();
      expect(tree.rootNode.type).toBe('module');
      console.log('✅ Python code parsed successfully');
      console.log(`   Root node type: ${tree.rootNode.type}`);
      console.log(`   Child count: ${tree.rootNode.childCount}`);
    });

    it('should execute Python queries successfully', () => {
      const pythonCode = `
def hello_world():
    print("Hello, World!")

class Calculator:
    def add(self, a, b):
        return a + b
    
    def subtract(self, a, b):
        return a - b

result = 42
`;

      const tree = parser.parse(pythonCode);
      
      // Test each Python query
      for (const [queryName, queryString] of Object.entries(PYTHON_QUERIES)) {
        try {
          const query = pythonLang.query(queryString as string);
          const matches = query.matches(tree.rootNode);
          
          console.log(`   ✅ ${queryName} query executed: ${matches.length} matches`);
          
          // Log some match details for verification
          if (matches.length > 0) {
            const firstMatch = matches[0];
            console.log(`      First match captures: ${firstMatch.captures.length}`);
            if (firstMatch.captures.length > 0) {
              const firstCapture = firstMatch.captures[0];
              console.log(`      First capture type: ${firstCapture.node.type}`);
              console.log(`      First capture text: "${firstCapture.node.text.substring(0, 50)}..."`);
            }
          }
        } catch (error) {
          console.error(`   ❌ ${queryName} query failed:`, error);
          throw error;
        }
      }
    });

    it('should extract definitions correctly', () => {
      const pythonCode = `
import os
from datetime import datetime

def process_data(input_data):
    return input_data.upper()

class DataProcessor:
    def __init__(self):
        self.data = []
    
    def add_item(self, item):
        self.data.append(item)
    
    async def process_async(self):
        return await some_async_operation()

@decorator
def decorated_function():
    pass

global_var = "test"
`;

      const tree = parser.parse(pythonCode);
      let totalDefinitions = 0;

      for (const [queryName, queryString] of Object.entries(PYTHON_QUERIES)) {
        const query = pythonLang.query(queryString as string);
        const matches = query.matches(tree.rootNode);
        
        for (const match of matches) {
          for (const capture of match.captures) {
            totalDefinitions++;
            const node = capture.node;
            console.log(`   Found ${queryName}: "${node.text.split('\n')[0]}" at line ${node.startPosition.row + 1}`);
          }
        }
      }

      expect(totalDefinitions).toBeGreaterThan(0);
      console.log(`✅ Extracted ${totalDefinitions} total definitions`);
    });
  });

  describe('TypeScript WASM Parsing Verification', () => {
    let typescriptLang: Parser.Language;

    beforeAll(async () => {
      typescriptLang = await loadTypeScriptParser();
      parser.setLanguage(typescriptLang);
    });

    it('should parse TypeScript code', () => {
      const tsCode = `
import React from 'react';

interface User {
  id: number;
  name: string;
}

class UserService {
  getUser(id: number): User {
    return { id, name: 'Test User' };
  }
}

const createUser = (name: string): User => {
  return { id: Date.now(), name };
};

function processUser(user: User): void {
  console.log(user.name);
}
`;

      const tree = parser.parse(tsCode);
      expect(tree).toBeDefined();
      expect(tree.rootNode.type).toBe('program');
      console.log('✅ TypeScript code parsed successfully');
    });

    it('should execute TypeScript queries successfully', () => {
      const tsCode = `
class TestClass {
  method(): string {
    return "test";
  }
}

function testFunction(): void {}

const arrowFunc = () => "result";

interface TestInterface {
  prop: string;
}
`;

      const tree = parser.parse(tsCode);
      
      for (const [queryName, queryString] of Object.entries(TYPESCRIPT_QUERIES)) {
        try {
          const query = typescriptLang.query(queryString as string);
          const matches = query.matches(tree.rootNode);
          console.log(`   ✅ ${queryName} query executed: ${matches.length} matches`);
        } catch (error) {
          console.error(`   ❌ ${queryName} query failed:`, error);
          throw error;
        }
      }
    });
  });

  describe('Worker Thread WASM Verification', () => {
    it('should verify worker can load and use WASM', async () => {
      // Create a test worker to verify WASM loading
      const workerCode = `
        import Parser from 'web-tree-sitter';
        
        async function testWorkerWasm() {
          try {
            // Test worker WASM initialization
            await Parser.init();
            const parser = new Parser();
            
            // Test loading Python parser
            const pythonLang = await Parser.Language.load('/wasm/python/tree-sitter-python.wasm');
            parser.setLanguage(pythonLang);
            
            // Test parsing
            const tree = parser.parse('def test(): pass');
            
            return {
              success: true,
              rootNodeType: tree.rootNode.type,
              childCount: tree.rootNode.childCount
            };
          } catch (error) {
            return {
              success: false,
              error: error.message
            };
          }
        }
        
        testWorkerWasm().then(result => {
          self.postMessage(result);
        });
      `;

      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      
      const workerResult = await new Promise((resolve, reject) => {
        const worker = new Worker(workerUrl, { type: 'module' });
        
        worker.onmessage = (event) => {
          worker.terminate();
          URL.revokeObjectURL(workerUrl);
          resolve(event.data);
        };
        
        worker.onerror = (error) => {
          worker.terminate();
          URL.revokeObjectURL(workerUrl);
          reject(error);
        };
        
        // Timeout after 10 seconds
        setTimeout(() => {
          worker.terminate();
          URL.revokeObjectURL(workerUrl);
          reject(new Error('Worker test timeout'));
        }, 10000);
      });

      console.log('🔍 Worker WASM test result:', workerResult);
      expect(workerResult).toHaveProperty('success');
      
      if (!(workerResult as any).success) {
        throw new Error(`Worker WASM failed: ${(workerResult as any).error}`);
      }
      
      console.log('✅ Worker WASM verification passed');
    }, 15000); // 15 second timeout for this test
  });

  describe('WASM File Accessibility Check', () => {
    it('should verify WASM files are accessible', async () => {
      const wasmFiles = [
        '/wasm/python/tree-sitter-python.wasm',
        '/wasm/javascript/tree-sitter-javascript.wasm',
        '/wasm/typescript/tree-sitter-typescript.wasm',
        '/wasm/tree-sitter.wasm'
      ];

      for (const wasmPath of wasmFiles) {
        try {
          const response = await fetch(wasmPath);
          expect(response.ok).toBe(true);
          expect(response.headers.get('content-type')).toContain('wasm');
          console.log(`✅ ${wasmPath} is accessible (${response.status})`);
        } catch (error) {
          console.error(`❌ ${wasmPath} failed to load:`, error);
          throw error;
        }
      }
    });
  });
});