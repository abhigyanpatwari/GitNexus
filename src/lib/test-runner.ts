import { runImportExtractionTests } from './import-extraction-test';

/**
 * Simple test runner for debugging import extraction
 */
export function runTests(): void {
  console.log('🚀 Starting Test Runner');
  console.log('========================');
  
  try {
    runImportExtractionTests();
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
  
  console.log('\n🏁 Test runner completed');
}

// Auto-run if this file is executed directly
if (typeof window !== 'undefined') {
  // Browser environment - expose to global scope
  (window as any).runImportTests = runTests;
  console.log('🧪 Import extraction tests available at window.runImportTests()');
}


