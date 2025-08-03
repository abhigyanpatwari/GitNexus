// Preload all dependencies that might be loaded during processing
// This ensures Vite optimizes them during initial build rather than during runtime

import 'web-tree-sitter';
import 'comlink';

// Import all the processing modules to ensure their dependencies are discovered
import '../core/ingestion/pipeline';
import '../core/ingestion/parsing-processor';
import '../core/ingestion/call-processor';
import '../core/ingestion/structure-processor';
import '../core/tree-sitter/parser-loader';

console.log('Dependencies preloaded to prevent runtime optimization'); 