import type { ParsedAST } from '../core/ingestion/types';

/**
 * Test function to analyze real AST structure from the pipeline
 */
export function analyzeRealAST(ast: ParsedAST, filePath: string): void {
  console.log(`\n🔍 Analyzing Real AST for ${filePath}`);
  console.log('=====================================');
  
  if (!ast.tree) {
    console.log('❌ No AST tree found');
    return;
  }
  
  console.log(`AST tree type: ${ast.tree.type}`);
  console.log(`AST tree childCount: ${ast.tree.childCount}`);
  console.log(`AST tree children length: ${ast.tree.children?.length}`);
  console.log(`AST tree text preview: "${ast.tree.text?.substring(0, 100)}..."`);
  
  // Analyze top-level children
  if (ast.tree.children) {
    console.log('\n📋 Top-level children analysis:');
    ast.tree.children.forEach((child, index) => {
      console.log(`  ${index}: ${child.type} - "${child.text}"`);
      
      // Look for import-related nodes
      if (child.type.includes('import')) {
        console.log(`    🔍 IMPORT NODE FOUND: ${child.type}`);
        console.log(`    Text: "${child.text}"`);
        console.log(`    Child count: ${child.childCount}`);
        console.log(`    Children: ${child.children?.length || 0}`);
        
        if (child.children) {
          child.children.forEach((grandChild, gcIndex) => {
            console.log(`      ${gcIndex}: ${grandChild.type} - "${grandChild.text}"`);
          });
        }
      }
    });
  }
  
  // Search for import statements recursively
  console.log('\n🔍 Searching for import statements recursively...');
  const importNodes = findImportNodes(ast.tree);
  
  if (importNodes.length === 0) {
    console.log('❌ No import nodes found in AST');
  } else {
    console.log(`✅ Found ${importNodes.length} import-related nodes:`);
    importNodes.forEach((node, index) => {
      console.log(`  ${index + 1}: ${node.type} - "${node.text}"`);
    });
  }
}

/**
 * Recursively find all import-related nodes
 */
function findImportNodes(node: any): any[] {
  const importNodes: any[] = [];
  
  if (!node || !node.type) return importNodes;
  
  // Check if this node is import-related
  if (node.type.includes('import') || node.type.includes('Import')) {
    importNodes.push(node);
  }
  
  // Recursively check children
  if (node.children) {
    for (const child of node.children) {
      if (child) {
        importNodes.push(...findImportNodes(child));
      }
    }
  }
  
  return importNodes;
}

/**
 * Compare expected vs actual AST structure
 */
export function compareASTStructures(expected: any, actual: any, context: string = ''): void {
  console.log(`\n🔍 Comparing AST structures ${context}`);
  console.log('=====================================');
  
  if (!expected || !actual) {
    console.log('❌ Missing expected or actual AST');
    return;
  }
  
  console.log(`Expected type: ${expected.type}`);
  console.log(`Actual type: ${actual.type}`);
  
  if (expected.type !== actual.type) {
    console.log(`❌ Type mismatch: expected "${expected.type}", got "${actual.type}"`);
  } else {
    console.log(`✅ Types match: ${expected.type}`);
  }
  
  console.log(`Expected childCount: ${expected.childCount}`);
  console.log(`Actual childCount: ${actual.childCount}`);
  
  if (expected.childCount !== actual.childCount) {
    console.log(`❌ Child count mismatch: expected ${expected.childCount}, got ${actual.childCount}`);
  } else {
    console.log(`✅ Child counts match: ${expected.childCount}`);
  }
  
  // Compare children
  const expectedChildren = expected.children || [];
  const actualChildren = actual.children || [];
  
  console.log(`Expected children length: ${expectedChildren.length}`);
  console.log(`Actual children length: ${actualChildren.length}`);
  
  const minLength = Math.min(expectedChildren.length, actualChildren.length);
  
  for (let i = 0; i < minLength; i++) {
    const expectedChild = expectedChildren[i];
    const actualChild = actualChildren[i];
    
    console.log(`\n  Child ${i}:`);
    console.log(`    Expected: ${expectedChild.type} - "${expectedChild.text}"`);
    console.log(`    Actual: ${actualChild.type} - "${actualChild.text}"`);
    
    if (expectedChild.type !== actualChild.type) {
      console.log(`    ❌ Type mismatch`);
    } else {
      console.log(`    ✅ Types match`);
    }
  }
  
  if (expectedChildren.length !== actualChildren.length) {
    console.log(`❌ Children length mismatch: expected ${expectedChildren.length}, got ${actualChildren.length}`);
  } else {
    console.log(`✅ Children lengths match`);
  }
}

/**
 * Test function to extract imports from real AST using our logic
 */
export function testRealImportExtraction(ast: ParsedAST, filePath: string): void {
  console.log(`\n🔍 Testing Real Import Extraction for ${filePath}`);
  console.log('=====================================');
  
  if (!ast.tree) {
    console.log('❌ No AST tree found');
    return;
  }
  
  const language = detectLanguage(filePath);
  console.log(`Detected language: ${language}`);
  
  const imports: any[] = [];
  
  if (language === 'python') {
    extractPythonImportsFromRealAST(ast.tree, filePath, imports);
  } else if (language === 'javascript') {
    extractJavaScriptImportsFromRealAST(ast.tree, filePath, imports);
  }
  
  console.log(`Found ${imports.length} imports:`);
  imports.forEach((imp, index) => {
    console.log(`  ${index + 1}: ${imp.localName} from ${imp.targetFile}`);
  });
}

/**
 * Extract Python imports from real AST
 */
function extractPythonImportsFromRealAST(node: any, filePath: string, imports: any[]): void {
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
        extractPythonImportsFromRealAST(child, filePath, imports);
      }
    }
  }
}

/**
 * Extract JavaScript imports from real AST
 */
function extractJavaScriptImportsFromRealAST(node: any, filePath: string, imports: any[]): void {
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
      processJSImportClauseFromRealAST(importClauseNode, filePath, sourcePath, imports);
    }
  }

  // Recursively process children
  if (node.children) {
    for (const child of node.children) {
      if (child) {
        extractJavaScriptImportsFromRealAST(child, filePath, imports);
      }
    }
  }
}

/**
 * Process JavaScript import clause from real AST
 */
function processJSImportClauseFromRealAST(
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
 * Simple language detection
 */
function detectLanguage(filePath: string): 'python' | 'javascript' | 'typescript' {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (ext === 'py') return 'python';
  if (ext === 'ts' || ext === 'tsx') return 'typescript';
  return 'javascript';
}


