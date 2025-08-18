/**
 * Generic Web Worker
 * Handles various processing tasks that can be offloaded to workers
 */

// Task handlers
const taskHandlers = {
  // Text processing tasks
  textAnalysis: async (input) => {
    const { text, analysisType } = input;
    
    switch (analysisType) {
      case 'wordCount':
        return {
          wordCount: text.split(/\s+/).filter(word => word.length > 0).length,
          charCount: text.length,
          lineCount: text.split('\n').length
        };
      
      case 'identifierExtraction':
        const identifiers = text.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || [];
        return {
          identifiers: [...new Set(identifiers)],
          count: identifiers.length
        };
      
      case 'importExtraction':
        const importRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"`]([^'"`]+)['"`]/g;
        const imports = [];
        let match;
        while ((match = importRegex.exec(text)) !== null) {
          imports.push(match[1]);
        }
        return { imports: [...new Set(imports)] };
      
      default:
        throw new Error(`Unknown analysis type: ${analysisType}`);
    }
  },

  // File processing tasks
  fileAnalysis: async (input) => {
    const { filePath, content, analysisType } = input;
    
    switch (analysisType) {
      case 'basic':
        return {
          filePath,
          size: content.length,
          lines: content.split('\n').length,
          hasContent: content.trim().length > 0
        };
      
      case 'language':
        const ext = filePath.split('.').pop()?.toLowerCase();
        const languageMap = {
          'js': 'javascript',
          'jsx': 'javascript',
          'ts': 'typescript',
          'tsx': 'typescript',
          'py': 'python',
          'java': 'java',
          'cpp': 'cpp',
          'c': 'c',
          'cs': 'csharp',
          'php': 'php',
          'rb': 'ruby',
          'go': 'go',
          'rs': 'rust'
        };
        return {
          filePath,
          language: languageMap[ext] || 'unknown',
          extension: ext
        };
      
      default:
        throw new Error(`Unknown file analysis type: ${analysisType}`);
    }
  },

  // Data processing tasks
  dataProcessing: async (input) => {
    const { data, operation } = input;
    
    switch (operation) {
      case 'deduplicate':
        return [...new Set(data)];
      
      case 'filter':
        const { predicate } = input;
        // Note: This is a simplified version - in practice, you'd need to serialize the predicate
        return data.filter(item => {
          try {
            // Simple filtering - in real implementation, you'd need proper serialization
            return item && item.length > 0;
          } catch {
            return false;
          }
        });
      
      case 'transform':
        const { transformType } = input;
        switch (transformType) {
          case 'uppercase':
            return data.map(item => item.toUpperCase());
          case 'lowercase':
            return data.map(item => item.toLowerCase());
          case 'trim':
            return data.map(item => item.trim());
          default:
            throw new Error(`Unknown transform type: ${transformType}`);
        }
      
      default:
        throw new Error(`Unknown data operation: ${operation}`);
    }
  },

  // Pattern matching tasks
  patternMatching: async (input) => {
    const { text, patterns } = input;
    const results = [];
    
    for (const pattern of patterns) {
      try {
        const regex = new RegExp(pattern, 'g');
        const matches = [];
        let match;
        
        while ((match = regex.exec(text)) !== null) {
          matches.push({
            match: match[0],
            index: match.index,
            groups: match.slice(1)
          });
        }
        
        results.push({
          pattern,
          matches,
          count: matches.length
        });
      } catch (error) {
        results.push({
          pattern,
          error: error.message,
          count: 0
        });
      }
    }
    
    return results;
  },

  // Statistical analysis tasks
  statisticalAnalysis: async (input) => {
    const { data, analysisType } = input;
    
    switch (analysisType) {
      case 'basic':
        const numbers = data.filter(item => typeof item === 'number' && !isNaN(item));
        if (numbers.length === 0) {
          return { error: 'No valid numbers found' };
        }
        
        const sum = numbers.reduce((acc, val) => acc + val, 0);
        const mean = sum / numbers.length;
        const sorted = numbers.sort((a, b) => a - b);
        const median = sorted.length % 2 === 0 
          ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
          : sorted[Math.floor(sorted.length / 2)];
        
        return {
          count: numbers.length,
          sum,
          mean,
          median,
          min: sorted[0],
          max: sorted[sorted.length - 1]
        };
      
      case 'frequency':
        const frequency = {};
        for (const item of data) {
          const key = String(item);
          frequency[key] = (frequency[key] || 0) + 1;
        }
        return frequency;
      
      default:
        throw new Error(`Unknown statistical analysis type: ${analysisType}`);
    }
  }
};

// Main message handler
self.onmessage = async function(event) {
  const { taskId, input } = event.data;
  
  try {
    const { taskType, ...taskInput } = input;
    
    // Get the appropriate task handler
    const handler = taskHandlers[taskType];
    if (!handler) {
      throw new Error(`Unknown task type: ${taskType}`);
    }
    
    // Execute the task
    const result = await handler(taskInput);
    
    // Send result back to main thread
    self.postMessage({
      taskId,
      result
    });
    
  } catch (error) {
    // Send error back to main thread
    self.postMessage({
      taskId,
      error: error.message || 'Unknown error in generic worker'
    });
  }
};

// Handle worker errors
self.onerror = function(error) {
  console.error('Worker: Unhandled error:', error);
  self.postMessage({
    taskId: 'error',
    error: error.message || 'Unhandled worker error'
  });
};

// Handle unhandled promise rejections
self.onunhandledrejection = function(event) {
  console.error('Worker: Unhandled promise rejection:', event.reason);
  self.postMessage({
    taskId: 'error',
    error: event.reason?.message || 'Unhandled promise rejection'
  });
};

console.log('Worker: Generic worker script loaded');
