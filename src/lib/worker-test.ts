/**
 * Test file for worker functionality
 */

export async function testTreeSitterWorker() {
  try {
    console.log('Testing tree-sitter worker...');
    
    // Create a worker
    const worker = new Worker('/workers/tree-sitter-worker.js', { type: 'module' });
    
    // Set up message handling
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Worker initialization timeout'));
      }, 10000);
      
      worker.onmessage = (event) => {
        clearTimeout(timeout);
        if (event.data.type === 'initialized') {
          resolve(event.data.success);
        } else if (event.data.type === 'error') {
          reject(new Error(event.data.error));
        }
      };
      
      worker.onerror = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      
      // Send initialization message
      worker.postMessage({ type: 'init' });
    });
    
    console.log('Worker test result:', result);
    worker.terminate();
    return result;
    
  } catch (error) {
    console.error('Worker test failed:', error);
    return false;
  }
}
