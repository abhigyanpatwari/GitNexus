import type { ParsedAST } from '../core/ingestion/types';

// Test Python file with various import statements
const testPythonCode = `
import os
import sys
from datetime import datetime, timezone
from typing import List, Dict, Optional
from .utils import helper_function
from ..common import base_class
import numpy as np
from fastapi import FastAPI, APIRouter
`;

// Test JavaScript file with various import statements
const testJavaScriptCode = `
import React from 'react';
import { useState, useEffect } from 'react';
import * as utils from './utils';
import { Button, Input } from './components';
import type { User } from './types';
const express = require('express');
const path = require('path');
`;

// Mock serialized AST structure for Python
const mockPythonAST: ParsedAST = {
  tree: {
    type: 'module',
    text: testPythonCode,
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 10, column: 0 },
    childCount: 7,
    children: [
      {
        type: 'import_statement',
        text: 'import os',
        startPosition: { row: 1, column: 0 },
        endPosition: { row: 1, column: 8 },
        childCount: 1,
        children: [
          {
            type: 'module_name',
            text: 'os',
            startPosition: { row: 1, column: 7 },
            endPosition: { row: 1, column: 8 },
            childCount: 0,
            children: []
          }
        ]
      },
      {
        type: 'import_statement',
        text: 'import sys',
        startPosition: { row: 2, column: 0 },
        endPosition: { row: 2, column: 8 },
        childCount: 1,
        children: [
          {
            type: 'module_name',
            text: 'sys',
            startPosition: { row: 2, column: 7 },
            endPosition: { row: 2, column: 8 },
            childCount: 0,
            children: []
          }
        ]
      },
      {
        type: 'import_from_statement',
        text: 'from datetime import datetime, timezone',
        startPosition: { row: 3, column: 0 },
        endPosition: { row: 3, column: 35 },
        childCount: 2,
        children: [
          {
            type: 'module_name',
            text: 'datetime',
            startPosition: { row: 3, column: 5 },
            endPosition: { row: 3, column: 13 },
            childCount: 0,
            children: []
          },
          {
            type: 'import_list',
            text: 'datetime, timezone',
            startPosition: { row: 3, column: 22 },
            endPosition: { row: 3, column: 35 },
            childCount: 2,
            children: [
              {
                type: 'identifier',
                text: 'datetime',
                startPosition: { row: 3, column: 22 },
                endPosition: { row: 3, column: 30 },
                childCount: 0,
                children: []
              },
              {
                type: 'identifier',
                text: 'timezone',
                startPosition: { row: 3, column: 32 },
                endPosition: { row: 3, column: 39 },
                childCount: 0,
                children: []
              }
            ]
          }
        ]
      }
    ]
  },
  language: 'python',
  filePath: 'test_python.py'
};

// Mock serialized AST structure for JavaScript
const mockJavaScriptAST: ParsedAST = {
  tree: {
    type: 'program',
    text: testJavaScriptCode,
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 8, column: 0 },
    childCount: 6,
    children: [
      {
        type: 'import_statement',
        text: "import React from 'react';",
        startPosition: { row: 1, column: 0 },
        endPosition: { row: 1, column: 24 },
        childCount: 2,
        children: [
          {
            type: 'import_clause',
            text: 'React',
            startPosition: { row: 1, column: 7 },
            endPosition: { row: 1, column: 12 },
            childCount: 1,
            children: [
              {
                type: 'identifier',
                text: 'React',
                startPosition: { row: 1, column: 7 },
                endPosition: { row: 1, column: 12 },
                childCount: 0,
                children: []
              }
            ]
          },
          {
            type: 'source',
            text: "'react'",
            startPosition: { row: 1, column: 18 },
            endPosition: { row: 1, column: 24 },
            childCount: 0,
            children: []
          }
        ]
      },
      {
        type: 'import_statement',
        text: "import { useState, useEffect } from 'react';",
        startPosition: { row: 2, column: 0 },
        endPosition: { row: 2, column: 42 },
        childCount: 2,
        children: [
          {
            type: 'import_clause',
            text: '{ useState, useEffect }',
            startPosition: { row: 2, column: 7 },
            endPosition: { row: 2, column: 28 },
            childCount: 2,
            children: [
              {
                type: 'import_specifier',
                text: 'useState',
                startPosition: { row: 2, column: 9 },
                endPosition: { row: 2, column: 16 },
                childCount: 1,
                children: [
                  {
                    type: 'name',
                    text: 'useState',
                    startPosition: { row: 2, column: 9 },
                    endPosition: { row: 2, column: 16 },
                    childCount: 0,
                    children: []
                  }
                ]
              },
              {
                type: 'import_specifier',
                text: 'useEffect',
                startPosition: { row: 2, column: 18 },
                endPosition: { row: 2, column: 26 },
                childCount: 1,
                children: [
                  {
                    type: 'name',
                    text: 'useEffect',
                    startPosition: { row: 2, column: 18 },
                    endPosition: { row: 2, column: 26 },
                    childCount: 0,
                    children: []
                  }
                ]
              }
            ]
          },
          {
            type: 'source',
            text: "'react'",
            startPosition: { row: 2, column: 36 },
            endPosition: { row: 2, column: 42 },
            childCount: 0,
            children: []
          }
        ]
      }
    ]
  },
  language: 'javascript',
  filePath: 'test_javascript.js'
};

/**
 * Test AST structure and node traversal
 */
export function testASTStructure(ast: ParsedAST, filePath: string): void {
  console.log(`\n🔍 Testing AST structure for ${filePath}`);
  console.log(`AST tree type: ${ast.tree?.type}`);
  console.log(`AST tree childCount: ${ast.tree?.childCount}`);
  console.log(`AST tree children length: ${ast.tree?.children?.length}`);
  
  if (ast.tree?.children) {
    console.log('\n📋 Top-level children:');
    ast.tree.children.forEach((child, index) => {
      console.log(`  ${index}: ${child.type} - "${child.text}"`);
    });
  }
}

/**
 * Test import extraction logic
 */
export function testImportExtraction(ast: ParsedAST, filePath: string): void {
  console.log(`\n🔍 Testing import extraction for ${filePath}`);
  
  const language = detectLanguage(filePath);
  console.log(`Detected language: ${language}`);
  
  const imports: any[] = [];
  
  if (language === 'python') {
    extractPythonImportsTest(ast.tree, filePath, imports);
  } else if (language === 'javascript') {
    extractJavaScriptImportsTest(ast.tree, filePath, imports);
  }
  
  console.log(`Found ${imports.length} imports:`);
  imports.forEach((imp, index) => {
    console.log(`  ${index + 1}: ${imp.localName} from ${imp.targetFile}`);
  });
}

/**
 * Simple language detection
 */
function detectLanguage(filePath: string): 'python' | 'javascript' | 'typescript' {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (ext === 'py') return 'python';
  if (ext === 'ts' || ext === 'tsx') return 'typescript';
  return 'javascript';
}

/**
 * Test Python import extraction
 */
function extractPythonImportsTest(node: any, filePath: string, imports: any[]): void {
  if (!node || !node.type) return;
  
  console.log(`  Checking node: ${node.type} - "${node.text}"`);
  
  if (node.type === 'import_statement') {
    console.log(`    ✅ Found import_statement: ${node.text}`);
    const moduleNode = node.children?.find((child: any) => child.type === 'module_name');
    if (moduleNode) {
      const moduleName = moduleNode.text;
      imports.push({
        importingFile: filePath,
        localName: moduleName,
        targetFile: moduleName,
        exportedName: moduleName,
        importType: 'namespace'
      });
    }
  } else if (node.type === 'import_from_statement') {
    console.log(`    ✅ Found import_from_statement: ${node.text}`);
    const moduleNode = node.children?.find((child: any) => child.type === 'module_name');
    const namesNode = node.children?.find((child: any) => child.type === 'import_list');
    
    if (moduleNode && namesNode) {
      const moduleName = moduleNode.text;
      console.log(`      Module: ${moduleName}`);
      console.log(`      Names node type: ${namesNode.type}`);
      console.log(`      Names node children: ${namesNode.children?.length}`);
      
      if (namesNode.children) {
        for (const nameNode of namesNode.children) {
          if (nameNode && nameNode.type === 'identifier') {
            const importName = nameNode.text;
            console.log(`        Import name: ${importName}`);
            imports.push({
              importingFile: filePath,
              localName: importName,
              targetFile: moduleName,
              exportedName: importName,
              importType: 'named'
            });
          }
        }
      }
    }
  }

  // Recursively process children
  if (node.children) {
    for (const child of node.children) {
      if (child) {
        extractPythonImportsTest(child, filePath, imports);
      }
    }
  }
}

/**
 * Test JavaScript import extraction
 */
function extractJavaScriptImportsTest(node: any, filePath: string, imports: any[]): void {
  if (!node || !node.type) return;
  
  console.log(`  Checking node: ${node.type} - "${node.text}"`);
  
  if (node.type === 'import_statement') {
    console.log(`    ✅ Found import_statement: ${node.text}`);
    const sourceNode = node.children?.find((child: any) => child.type === 'source');
    if (!sourceNode) return;

    const sourcePath = sourceNode.text.replace(/['"]/g, '');
    console.log(`      Source: ${sourcePath}`);

    // Handle different import patterns
    const importClauseNode = node.children?.find((child: any) => child.type === 'import_clause');
    if (importClauseNode) {
      processJSImportClauseTest(importClauseNode, filePath, sourcePath, imports);
    }
  }

  // Recursively process children
  if (node.children) {
    for (const child of node.children) {
      if (child) {
        extractJavaScriptImportsTest(child, filePath, imports);
      }
    }
  }
}

/**
 * Test JavaScript import clause processing
 */
function processJSImportClauseTest(
  importClauseNode: any,
  filePath: string,
  targetFile: string,
  imports: any[]
): void {
  console.log(`    Processing import clause: ${importClauseNode.text}`);
  
  for (const child of importClauseNode.children || []) {
    if (!child) continue;

    console.log(`      Clause child: ${child.type} - "${child.text}"`);

    if (child.type === 'import_specifier') {
      // Named import: { name } or { name as alias }
      const nameNode = child.children?.find((c: any) => c.type === 'name');
      const aliasNode = child.children?.find((c: any) => c.type === 'alias');
      
      if (nameNode) {
        const localName = aliasNode ? aliasNode.text : nameNode.text;
        console.log(`        Named import: ${nameNode.text} as ${localName}`);
        imports.push({
          importingFile: filePath,
          localName,
          targetFile,
          exportedName: nameNode.text,
          importType: 'named'
        });
      }
    } else if (child.type === 'namespace_import') {
      // Namespace import: * as name
      const nameNode = child.children?.find((c: any) => c.type === 'name');
      if (nameNode) {
        console.log(`        Namespace import: * as ${nameNode.text}`);
        imports.push({
          importingFile: filePath,
          localName: nameNode.text,
          targetFile,
          exportedName: '*',
          importType: 'namespace'
        });
      }
    } else if (child.type === 'identifier') {
      // Default import: name
      console.log(`        Default import: ${child.text}`);
      imports.push({
        importingFile: filePath,
        localName: child.text,
        targetFile,
        exportedName: 'default',
        importType: 'default'
      });
    }
  }
}

/**
 * Run all tests
 */
export function runImportExtractionTests(): void {
  console.log('🧪 Running Import Extraction Tests');
  console.log('=====================================');
  
  // Test Python AST
  testASTStructure(mockPythonAST, 'test_python.py');
  testImportExtraction(mockPythonAST, 'test_python.py');
  
  // Test JavaScript AST
  testASTStructure(mockJavaScriptAST, 'test_javascript.js');
  testImportExtraction(mockJavaScriptAST, 'test_javascript.js');
  
  console.log('\n✅ Import extraction tests completed');
}





