/**
 * Tree-sitter Web Worker
 * Handles parallel parsing of source code files
 */

// Import tree-sitter and language parsers
import Parser from 'web-tree-sitter';

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

// Get queries for specific language
function getQueriesForLanguage(language) {
  const queries = {
    typescript: {
      function_declaration: `
        (function_declaration
          name: (identifier) @function.name
          parameters: (formal_parameters) @function.parameters
          body: (statement_block) @function.body
        )
      `,
      class_declaration: `
        (class_declaration
          name: (identifier) @class.name
          body: (class_body) @class.body
        )
      `,
      method_definition: `
        (method_definition
          name: (property_identifier) @method.name
          parameters: (formal_parameters) @method.parameters
          body: (statement_block) @method.body
        )
      `,
      import_statement: `
        (import_statement
          source: (string) @import.source
        )
      `
    },
    javascript: {
      function_declaration: `
        (function_declaration
          name: (identifier) @function.name
          parameters: (formal_parameters) @function.parameters
          body: (statement_block) @function.body
        )
      `,
      arrow_function: `
        (arrow_function
          parameters: (formal_parameters) @function.parameters
          body: (statement_block) @function.body
        )
      `,
      class_declaration: `
        (class_declaration
          name: (identifier) @class.name
          body: (class_body) @class.body
        )
      `
    },
    python: {
      function_definition: `
        (function_definition
          name: (identifier) @function.name
          parameters: (parameters) @function.parameters
          body: (block) @function.body
        )
      `,
      class_definition: `
        (class_definition
          name: (identifier) @class.name
          body: (block) @class.body
        )
      `,
      import_statement: `
        (import_statement
          name: (dotted_name) @import.name
        )
      `
    }
  };

  return queries[language] || null;
}

// Process a query match into a definition
function processMatch(match, filePath, queryType) {
  try {
    const captures = match.captures;
    const definition = {
      type: queryType,
      filePath,
      startLine: match.node.startPosition.row,
      endLine: match.node.endPosition.row,
      startColumn: match.node.startPosition.column,
      endColumn: match.node.endPosition.column
    };

    // Extract specific information based on query type
    for (const capture of captures) {
      const { name, node } = capture;
      
      if (name.includes('name')) {
        definition.name = node.text;
      } else if (name.includes('parameters')) {
        definition.parameters = node.text;
      } else if (name.includes('source')) {
        definition.importSource = node.text.replace(/['"]/g, '');
      }
    }

    return definition;
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
