/**
 * Tree-sitter Web Worker
 * Handles parallel parsing of source code files
 */

// Import tree-sitter and language parsers
import Parser from 'web-tree-sitter';
// Import compiled queries (generated from TypeScript)
import { getQueriesForLanguage } from './compiled-queries.js';

// Initialize tree-sitter
let parser = null;
let languageParsers = new Map();

// Initialize the worker
async function initializeWorker() {
  try {
    // Initialize tree-sitter
    await Parser.init();
    parser = new Parser();
    
    // Load language parsers
    const languageLoaders = {
      typescript: async () => {
        const language = await Parser.Language.load('/wasm/typescript/tree-sitter-typescript.wasm');
        return language;
      },
      javascript: async () => {
        const language = await Parser.Language.load('/wasm/javascript/tree-sitter-javascript.wasm');
        return language;
      },
      python: async () => {
        const language = await Parser.Language.load('/wasm/python/tree-sitter-python.wasm');
        return language;
      }
    };

    for (const [lang, loader] of Object.entries(languageLoaders)) {
      try {
        const languageParser = await loader();
        languageParsers.set(lang, languageParser);
        console.log(`Worker: ${lang} parser loaded successfully`);
      } catch (error) {
        console.error(`Worker: Failed to load ${lang} parser:`, error);
      }
    }

    console.log('Worker: Tree-sitter worker initialized successfully');
    return true;
  } catch (error) {
    console.error('Worker: Failed to initialize tree-sitter worker:', error);
    return false;
  }
}

// Detect language from file path
function detectLanguage(filePath) {
  const ext = filePath.split('.').pop()?.toLowerCase();
  
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
      return 'javascript';
    case 'py':
      return 'python';
    default:
      return 'javascript'; // Default fallback
  }
}

// Extract definitions from AST
function extractDefinitions(tree, filePath) {
  const definitions = [];
  const language = detectLanguage(filePath);
  
  // Get queries for the language
  const queries = getQueriesForLanguage(language);
  if (!queries) return definitions;

  // Execute queries to find definitions
  for (const [queryName, queryString] of Object.entries(queries)) {
    try {
      const query = parser.getLanguage().query(queryString);
      const matches = query.matches(tree.rootNode);

      for (const match of matches) {
        const definition = processMatch(match, filePath, queryName);
        if (definition) {
          definitions.push(definition);
        }
      }
    } catch (error) {
      console.warn(`Worker: Error executing query ${queryName}:`, error);
    }
  }

  return definitions;
}

// Get queries for specific language - now uses imported compiled queries
// This ensures consistency with the main thread parsing logic

// Helper function to map query names to definition types (matches main thread)
function getDefinitionType(queryName) {
  switch (queryName) {
    case 'classes': return 'class';
    case 'methods': return 'method';
    case 'functions':
    case 'arrowFunctions': return 'function';
    case 'imports':
    case 'from_imports': return 'import';
    case 'interfaces': return 'interface';
    case 'types': return 'type';
    case 'decorators': return 'decorator';
    default: return 'variable';
  }
}

// Process a query match into a definition
// Updated to match main thread's extractDefinition logic exactly
function processMatch(match, filePath, queryType) {
  try {
    // Main thread processes each capture individually
    // For each match, process all captures
    const definitions = [];
    
    for (const capture of match.captures) {
      const node = capture.node;
      
      // Extract name from the node (same logic as main thread)
      const nameNode = node.childForFieldName('name');
      const name = nameNode ? nameNode.text : 'anonymous';

      const definition = {
        name: name,
        type: getDefinitionType(queryType), // Use proper type mapping
        filePath: filePath,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        startColumn: node.startPosition.column,
        endColumn: node.endPosition.column
      };

      // Extract additional fields if available
      const parametersNode = node.childForFieldName('parameters');
      if (parametersNode) {
        definition.parameters = parametersNode.text;
      }

      definitions.push(definition);
    }
    
    // Return the first definition (main thread processes one capture at a time)
    return definitions.length > 0 ? definitions[0] : null;
  } catch (error) {
    console.warn('Worker: Error processing match:', error);
    return null;
  }
}

// Parse a single file
async function parseFile(filePath, content) {
  try {
    const language = detectLanguage(filePath);
    const languageParser = languageParsers.get(language);
    
    if (!languageParser) {
      throw new Error(`No parser available for language: ${language}`);
    }

    // Set the language
    parser.setLanguage(languageParser);
    
    // Parse the content
    const tree = parser.parse(content);
    
    // Extract definitions
    const definitions = extractDefinitions(tree, filePath);
    
    return {
      filePath,
      definitions,
      ast: {
        tree: {
          rootNode: {
            startPosition: tree.rootNode.startPosition,
            endPosition: tree.rootNode.endPosition,
            type: tree.rootNode.type,
            text: tree.rootNode.text
          }
        }
      }
    };
  } catch (error) {
    console.error(`Worker: Error parsing file ${filePath}:`, error);
    throw error;
  }
}

// Handle messages from main thread
self.onmessage = async function(event) {
  const { taskId, input } = event.data;
  
  try {
    // Initialize worker if not already done
    if (!parser) {
      const initialized = await initializeWorker();
      if (!initialized) {
        throw new Error('Failed to initialize tree-sitter worker');
      }
    }

    const { filePath, content } = input;
    
    // Parse the file
    const result = await parseFile(filePath, content);
    
    // Send result back to main thread
    self.postMessage({
      taskId,
      result
    });
    
  } catch (error) {
    // Send error back to main thread
    self.postMessage({
      taskId,
      error: error.message || 'Unknown error in tree-sitter worker'
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

console.log('Worker: Tree-sitter worker script loaded');
