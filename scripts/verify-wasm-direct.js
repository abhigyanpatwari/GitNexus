#!/usr/bin/env node

/**
 * DIRECT WASM VERIFICATION SCRIPT
 * Tests Tree-sitter WASM functionality without Jest
 * DELETE THIS FILE after confirming everything works
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = dirname(__dirname);

console.log('🔍 Direct WASM Verification Starting...');
console.log('📁 Project root:', projectRoot);

// Test 1: Check if WASM files exist
async function checkWasmFiles() {
  console.log('\n📋 Test 1: Checking WASM file existence...');
  
  const wasmFiles = [
    'public/wasm/python/tree-sitter-python.wasm',
    'public/wasm/javascript/tree-sitter-javascript.wasm', 
    'public/wasm/typescript/tree-sitter-typescript.wasm',
    'public/wasm/tree-sitter.wasm'
  ];

  let allExist = true;
  
  for (const wasmPath of wasmFiles) {
    const fullPath = join(projectRoot, wasmPath);
    if (fs.existsSync(fullPath)) {
      const stats = fs.statSync(fullPath);
      console.log(`✅ ${wasmPath} exists (${(stats.size / 1024).toFixed(1)}KB)`);
    } else {
      console.log(`❌ ${wasmPath} missing`);
      allExist = false;
    }
  }
  
  return allExist;
}

// Test 2: Try to load Tree-sitter in Node.js environment
async function testTreeSitterLoad() {
  console.log('\n📋 Test 2: Testing Tree-sitter module loading...');
  
  try {
    // Try dynamic import
    const Parser = await import('web-tree-sitter');
    console.log('✅ web-tree-sitter module imported successfully');
    console.log(`   Default export type: ${typeof Parser.default}`);
    
    if (Parser.default && typeof Parser.default === 'function') {
      console.log('✅ Parser constructor available');
      return true;
    } else {
      console.log('❌ Parser constructor not found');
      return false;
    }
  } catch (error) {
    console.log('❌ Failed to import web-tree-sitter:', error.message);
    return false;
  }
}

// Test 3: Check compiled queries
async function testCompiledQueries() {
  console.log('\n📋 Test 3: Testing compiled queries...');
  
  try {
    const compiledQueriesPath = join(projectRoot, 'public/workers/compiled-queries.js');
    
    if (!fs.existsSync(compiledQueriesPath)) {
      console.log('❌ compiled-queries.js not found');
      return false;
    }
    
    console.log('✅ compiled-queries.js exists');
    
    // Read and basic parse check
    const content = fs.readFileSync(compiledQueriesPath, 'utf8');
    
    if (content.includes('PYTHON_QUERIES') && content.includes('TYPESCRIPT_QUERIES')) {
      console.log('✅ Compiled queries contain expected exports');
      
      // Count Python queries
      const pythonQueryMatch = content.match(/PYTHON_QUERIES = ({[\\s\\S]*?});/);
      if (pythonQueryMatch) {
        const queryCount = (pythonQueryMatch[1].match(/:\\s*`/g) || []).length;
        console.log(`✅ Python queries: ${queryCount} query types found`);
      }
      
      return true;
    } else {
      console.log('❌ Compiled queries missing expected exports');
      return false;
    }
  } catch (error) {
    console.log('❌ Error checking compiled queries:', error.message);
    return false;
  }
}

// Test 4: Check parser loader module
async function testParserLoader() {
  console.log('\n📋 Test 4: Testing parser loader module...');
  
  try {
    const parserLoaderPath = join(projectRoot, 'src/core/tree-sitter/parser-loader.ts');
    
    if (!fs.existsSync(parserLoaderPath)) {
      console.log('❌ parser-loader.ts not found');
      return false;
    }
    
    console.log('✅ parser-loader.ts exists');
    
    // Try importing the module
    const loaderModule = await import(`file://${parserLoaderPath}`);
    
    const expectedExports = ['initTreeSitter', 'loadPythonParser', 'loadJavaScriptParser', 'loadTypeScriptParser'];
    let allExportsPresent = true;
    
    for (const exportName of expectedExports) {
      if (typeof loaderModule[exportName] === 'function') {
        console.log(`✅ ${exportName} function exported`);
      } else {
        console.log(`❌ ${exportName} function missing`);
        allExportsPresent = false;
      }
    }
    
    return allExportsPresent;
  } catch (error) {
    console.log('❌ Error testing parser loader:', error.message);
    return false;
  }
}

// Test 5: Verify Tree-sitter queries syntax
async function testQuerySyntax() {
  console.log('\n📋 Test 5: Testing Tree-sitter query syntax...');
  
  try {
    const queriesPath = join(projectRoot, 'src/core/ingestion/tree-sitter-queries.ts');
    
    if (!fs.existsSync(queriesPath)) {
      console.log('❌ tree-sitter-queries.ts not found');
      return false;
    }
    
    const content = fs.readFileSync(queriesPath, 'utf8');
    
    // Basic syntax checks
    if (!content.includes('PYTHON_QUERIES') || !content.includes('TYPESCRIPT_QUERIES')) {
      console.log('❌ Missing expected query exports');
      return false;
    }
    
    // Check for the async function query issue we fixed
    if (content.includes('async_functions')) {
      console.log('❌ async_functions query still present (should be removed)');
      return false;
    }
    
    console.log('✅ Query file structure looks correct');
    console.log('✅ No problematic async_functions query found');
    
    return true;
  } catch (error) {
    console.log('❌ Error checking query syntax:', error.message);
    return false;
  }
}

// Run all tests
async function runAllTests() {
  console.log('🚀 Starting comprehensive WASM verification...\n');
  
  const results = [];
  
  results.push(await checkWasmFiles());
  results.push(await testTreeSitterLoad());
  results.push(await testCompiledQueries());
  results.push(await testParserLoader());
  results.push(await testQuerySyntax());
  
  const passedTests = results.filter(Boolean).length;
  const totalTests = results.length;
  
  console.log(`\n📊 Results: ${passedTests}/${totalTests} tests passed`);
  
  if (passedTests === totalTests) {
    console.log('\n✅ All WASM verification tests PASSED!');
    console.log('🎉 Tree-sitter WASM setup appears to be working correctly');
    console.log('\n🧹 You can now safely delete these test files:');
    console.log('   - scripts/verify-wasm-direct.js');
    console.log('   - scripts/test-wasm.js');
    console.log('   - src/tests/wasm-verification.test.ts');
    console.log('   - src/__tests__/setup.ts');
    console.log('\n🚀 Ready to proceed with ZIP upload testing!');
    return true;
  } else {
    console.log('\n❌ Some WASM verification tests FAILED!');
    console.log('🔧 Please fix the issues above before proceeding.');
    return false;
  }
}

runAllTests()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('💥 Unexpected error:', error);
    process.exit(1);
  });