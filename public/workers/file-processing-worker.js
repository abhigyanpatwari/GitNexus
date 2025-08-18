/**
 * File Processing Web Worker
 * Handles parallel file processing tasks
 */

// Import tree-sitter worker functionality
import './tree-sitter-worker.js';

// File processing task handlers
const fileProcessors = {
  // Parse file with tree-sitter
  parseFile: async (input) => {
    const { filePath, content } = input;
    
    // Use the tree-sitter worker functionality
    return await parseFile(filePath, content);
  },

  // Analyze file structure
  analyzeStructure: async (input) => {
    const { filePath, content } = input;
    
    const analysis = {
      filePath,
      size: content.length,
      lines: content.split('\n').length,
      characters: content.length,
      words: content.split(/\s+/).filter(word => word.length > 0).length,
      language: detectLanguage(filePath),
      hasContent: content.trim().length > 0,
      structure: {
        imports: [],
        exports: [],
        functions: [],
        classes: [],
        variables: []
      }
    };

    // Extract basic structure information
    const lines = content.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const lineNumber = i + 1;
      
      // Detect imports
      if (line.startsWith('import ') || line.startsWith('from ')) {
        analysis.structure.imports.push({
          line: lineNumber,
          content: line
        });
      }
      
      // Detect exports
      if (line.startsWith('export ')) {
        analysis.structure.exports.push({
          line: lineNumber,
          content: line
        });
      }
      
      // Detect function declarations
      if (line.match(/^(function|const|let|var)\s+\w+\s*[=\(]/)) {
        analysis.structure.functions.push({
          line: lineNumber,
          content: line
        });
      }
      
      // Detect class declarations
      if (line.match(/^class\s+\w+/)) {
        analysis.structure.classes.push({
          line: lineNumber,
          content: line
        });
      }
      
      // Detect variable declarations
      if (line.match(/^(const|let|var)\s+\w+\s*=/)) {
        analysis.structure.variables.push({
          line: lineNumber,
          content: line
        });
      }
    }

    return analysis;
  },

  // Extract dependencies
  extractDependencies: async (input) => {
    const { filePath, content } = input;
    
    const dependencies = {
      filePath,
      imports: [],
      requires: [],
      dynamicImports: []
    };

    const lines = content.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const lineNumber = i + 1;
      
      // ES6 imports
      const importMatch = line.match(/import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"`]([^'"`]+)['"`]/);
      if (importMatch) {
        dependencies.imports.push({
          module: importMatch[1],
          line: lineNumber,
          fullLine: line
        });
      }
      
      // CommonJS requires
      const requireMatch = line.match(/require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/);
      if (requireMatch) {
        dependencies.requires.push({
          module: requireMatch[1],
          line: lineNumber,
          fullLine: line
        });
      }
      
      // Dynamic imports
      const dynamicImportMatch = line.match(/import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/);
      if (dynamicImportMatch) {
        dependencies.dynamicImports.push({
          module: dynamicImportMatch[1],
          line: lineNumber,
          fullLine: line
        });
      }
    }

    return dependencies;
  },

  // Extract function calls
  extractFunctionCalls: async (input) => {
    const { filePath, content } = input;
    
    const functionCalls = {
      filePath,
      calls: []
    };

    // Simple regex-based function call detection
    // This is a simplified version - in practice, you'd use AST parsing
    const functionCallRegex = /(\w+)\s*\(/g;
    let match;
    
    while ((match = functionCallRegex.exec(content)) !== null) {
      const functionName = match[1];
      const lineNumber = content.substring(0, match.index).split('\n').length;
      
      // Skip common keywords that might match the pattern
      const keywords = ['if', 'for', 'while', 'switch', 'catch', 'typeof', 'instanceof'];
      if (!keywords.includes(functionName)) {
        functionCalls.calls.push({
          functionName,
          line: lineNumber,
          index: match.index
        });
      }
    }

    return functionCalls;
  },

  // Analyze code complexity
  analyzeComplexity: async (input) => {
    const { filePath, content } = input;
    
    const complexity = {
      filePath,
      cyclomaticComplexity: 0,
      nestingDepth: 0,
      maxLineLength: 0,
      averageLineLength: 0,
      commentRatio: 0
    };

    const lines = content.split('\n');
    let totalLength = 0;
    let commentLines = 0;
    let currentNesting = 0;
    let maxNesting = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();
      
      // Calculate line length
      const lineLength = line.length;
      totalLength += lineLength;
      complexity.maxLineLength = Math.max(complexity.maxLineLength, lineLength);
      
      // Count comment lines
      if (trimmedLine.startsWith('//') || trimmedLine.startsWith('/*') || trimmedLine.startsWith('*')) {
        commentLines++;
      }
      
      // Calculate nesting depth
      if (trimmedLine.includes('{')) {
        currentNesting++;
        maxNesting = Math.max(maxNesting, currentNesting);
      }
      if (trimmedLine.includes('}')) {
        currentNesting = Math.max(0, currentNesting - 1);
      }
      
      // Calculate cyclomatic complexity (simplified)
      const complexityKeywords = ['if', 'else', 'for', 'while', 'case', 'catch', '&&', '||', '?'];
      for (const keyword of complexityKeywords) {
        if (line.includes(keyword)) {
          complexity.cyclomaticComplexity++;
        }
      }
    }

    complexity.averageLineLength = lines.length > 0 ? totalLength / lines.length : 0;
    complexity.commentRatio = lines.length > 0 ? commentLines / lines.length : 0;
    complexity.nestingDepth = maxNesting;

    return complexity;
  }
};

// Detect language from file path
function detectLanguage(filePath) {
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
    'rs': 'rust',
    'json': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    'md': 'markdown',
    'html': 'html',
    'css': 'css',
    'scss': 'scss',
    'sass': 'sass'
  };
  
  return languageMap[ext] || 'unknown';
}

// Main message handler
self.onmessage = async function(event) {
  const { taskId, input } = event.data;
  
  try {
    const { processorType, ...processorInput } = input;
    
    // Get the appropriate processor
    const processor = fileProcessors[processorType];
    if (!processor) {
      throw new Error(`Unknown processor type: ${processorType}`);
    }
    
    // Execute the processor
    const result = await processor(processorInput);
    
    // Send result back to main thread
    self.postMessage({
      taskId,
      result
    });
    
  } catch (error) {
    // Send error back to main thread
    self.postMessage({
      taskId,
      error: error.message || 'Unknown error in file processing worker'
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

console.log('Worker: File processing worker script loaded');
