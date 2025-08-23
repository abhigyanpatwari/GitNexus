#!/usr/bin/env node

/**
 * Build-time script to compile TypeScript queries into JavaScript for Web Workers
 * This allows workers to import the same query definitions as the main thread
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the TypeScript queries file
const queriesPath = path.join(__dirname, '../src/core/ingestion/tree-sitter-queries.ts');
// Output path for compiled JavaScript queries
const outputPath = path.join(__dirname, '../public/workers/compiled-queries.js');

function compileQueries() {
  try {
    console.log('🔨 Compiling Tree-sitter queries for Web Workers...');
    
    // Read the TypeScript queries file
    const queriesContent = fs.readFileSync(queriesPath, 'utf8');
    
    // Extract the query objects using simple regex (since they're just object literals)
    const typescriptMatch = queriesContent.match(/export const TYPESCRIPT_QUERIES = ({[\s\S]*?});/);
    const javascriptMatch = queriesContent.match(/export const JAVASCRIPT_QUERIES = ({[\s\S]*?});/);
    const pythonMatch = queriesContent.match(/export const PYTHON_QUERIES = ({[\s\S]*?});/);
    const javaMatch = queriesContent.match(/export const JAVA_QUERIES = ({[\s\S]*?});/);
    
    if (!typescriptMatch || !javascriptMatch || !pythonMatch || !javaMatch) {
      throw new Error('Could not extract queries from TypeScript file');
    }
    
    // Create JavaScript module content
    const jsContent = `/**
 * AUTO-GENERATED FILE - DO NOT EDIT MANUALLY
 * Generated from src/core/ingestion/tree-sitter-queries.ts
 * Run 'npm run compile-queries' to regenerate
 */

export const TYPESCRIPT_QUERIES = ${typescriptMatch[1]};

export const JAVASCRIPT_QUERIES = ${javascriptMatch[1]};

export const PYTHON_QUERIES = ${pythonMatch[1]};

export const JAVA_QUERIES = ${javaMatch[1]};

// Helper function to get queries for a specific language
export function getQueriesForLanguage(language) {
  switch (language) {
    case 'typescript':
      return TYPESCRIPT_QUERIES;
    case 'javascript':
      return JAVASCRIPT_QUERIES;
    case 'python':
      return PYTHON_QUERIES;
    case 'java':
      return JAVA_QUERIES;
    default:
      return null;
  }
}

// Export individual query sets for backward compatibility
export const queries = {
  typescript: TYPESCRIPT_QUERIES,
  javascript: JAVASCRIPT_QUERIES,
  python: PYTHON_QUERIES,
  java: JAVA_QUERIES
};
`;
    
    // Ensure output directory exists
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Write the compiled JavaScript file
    fs.writeFileSync(outputPath, jsContent, 'utf8');
    
    console.log(`✅ Queries compiled successfully to: ${outputPath}`);
    
  } catch (error) {
    console.error('❌ Failed to compile queries:', error.message);
    process.exit(1);
  }
}

compileQueries();