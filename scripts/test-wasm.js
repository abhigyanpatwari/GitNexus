#!/usr/bin/env node

/**
 * TEMPORARY WASM TEST RUNNER
 * Run this to verify Tree-sitter WASM functionality
 * DELETE THIS FILE after confirming everything works
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

console.log('🔍 Starting WASM Verification Tests...');
console.log('📁 Project root:', projectRoot);

// Run the WASM verification tests
const testProcess = spawn('npm', ['run', 'test', 'src/tests/wasm-verification.test.ts'], {
  cwd: projectRoot,
  stdio: 'inherit',
  shell: true
});

testProcess.on('close', (code) => {
  if (code === 0) {
    console.log('\n✅ All WASM verification tests passed!');
    console.log('🧹 You can now safely delete:');
    console.log('   - src/tests/wasm-verification.test.ts');
    console.log('   - scripts/test-wasm.js');
  } else {
    console.log('\n❌ WASM verification tests failed!');
    console.log('🔧 Please check the issues above before proceeding.');
  }
  process.exit(code);
});

testProcess.on('error', (error) => {
  console.error('❌ Failed to run tests:', error);
  process.exit(1);
});