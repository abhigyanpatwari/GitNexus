import { KnowledgeGraph } from '../graph/types';
import { ASTCache } from './ast-cache';
import { loadParser, loadLanguage } from '../tree-sitter/parser-loader';
import { LANGUAGE_QUERIES } from './tree-sitter-queries';
import { generateId } from '../../lib/utils';
import { getLanguageFromFilename } from './utils';
import { callRouters } from './call-routing';

// Type: Map<FilePath, Set<ResolvedFilePath>>
// Stores all files that a given file imports from
export type ImportMap = Map<string, Set<string>>;

export const createImportMap = (): ImportMap => new Map();

// Helper: Resolve import paths (relative and absolute/package-style)
const resolveImportPath = (
  currentFile: string, 
  importPath: string, 
  allFiles: Set<string>,
  allFileList: string[],
  resolveCache: Map<string, string | null>
): string | null => {
  const cacheKey = `${currentFile}::${importPath}`;
  if (resolveCache.has(cacheKey)) return resolveCache.get(cacheKey) ?? null;

  // 1. Resolve '..' and '.' for relative imports
  const currentDir = currentFile.split('/').slice(0, -1);
  const parts = importPath.split('/');
  
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      currentDir.pop();
    } else {
      currentDir.push(part);
    }
  }
  
  const basePath = currentDir.join('/');

  // 2. Try extensions for all supported languages
  const extensions = [
    '', 
    // TypeScript/JavaScript
    '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js',
    // Python
    '.py', '/__init__.py',
    // Java
    '.java',
    // C/C++
    '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.hxx', '.hh',
    // C#
    '.cs',
    // Go
    '.go',
    // Rust
    '.rs', '/mod.rs',
    // Ruby
    '.rb', '.rake',
  ];
  
  if (importPath.startsWith('.')) {
    for (const ext of extensions) {
      const candidate = basePath + ext;
      if (allFiles.has(candidate)) {
        resolveCache.set(cacheKey, candidate);
        return candidate;
      }
    }
    resolveCache.set(cacheKey, null);
    return null;
  }

  // 3. Handle absolute/package imports (Java, Go, Python, etc.)
  if (importPath.endsWith('.*')) {
    resolveCache.set(cacheKey, null);
    return null;
  }

  const pathLike = importPath.includes('/')
    ? importPath
    : importPath.replace(/\./g, '/');
  const pathParts = pathLike.split('/').filter(Boolean);

  // Normalize all file paths to forward slashes for matching
  const normalizedFileList = allFileList.map(p => p.replace(/\\/g, '/'));

  for (let i = 0; i < pathParts.length; i++) {
    const suffix = pathParts.slice(i).join('/');
    for (const ext of extensions) {
      const suffixWithExt = suffix + ext;
      // Require path separator before match to avoid false positives like "View.java" matching "RootView.java"
      const suffixPattern = '/' + suffixWithExt;
      const matchIdx = normalizedFileList.findIndex(filePath => 
        filePath.endsWith(suffixPattern) || filePath.toLowerCase().endsWith(suffixPattern.toLowerCase())
      );
      if (matchIdx !== -1) {
        const match = allFileList[matchIdx];
        resolveCache.set(cacheKey, match);
        return match;
      }
    }
  }

  // Unresolved imports (external packages, SDK imports) are expected - don't log
  resolveCache.set(cacheKey, null);
  return null;
};

export const processImports = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  importMap: ImportMap,
  onProgress?: (current: number, total: number) => void
) => {
  // Create a Set of all file paths for fast lookup during resolution
  const allFilePaths = new Set(files.map(f => f.path));
  const parser = await loadParser();
  const resolveCache = new Map<string, string | null>();
  const allFileList = files.map(f => f.path);
  
  // Track import statistics
  let totalImportsFound = 0;
  let totalImportsResolved = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress?.(i + 1, files.length);

    // 1. Check language support first
    const language = getLanguageFromFilename(file.path);
    if (!language) continue;
    
    const queryStr = LANGUAGE_QUERIES[language];
    if (!queryStr) continue;

    // 2. ALWAYS load the language before querying (parser is stateful)
    await loadLanguage(language, file.path);

    // 3. Get AST (Try Cache First)
    let tree = astCache.get(file.path);
    let wasReparsed = false;
    
    if (!tree) {
      // Cache Miss: Re-parse (slower, but necessary if evicted)
      tree = parser.parse(file.content);
      wasReparsed = true;
    }

    let query;
    let matches;
    try {
      query = parser.getLanguage().query(queryStr);
      matches = query.matches(tree.rootNode);
      
      // Removed verbose Java import logging
    } catch (queryError: any) {
      // Detailed debug logging for query failures
      console.group(`🔴 Query Error: ${file.path}`);
      console.log('Language:', language);
      console.log('Query (first 200 chars):', queryStr.substring(0, 200) + '...');
      console.log('Error:', queryError?.message || queryError);
      console.log('File content (first 300 chars):', file.content.substring(0, 300));
      console.log('AST root type:', tree.rootNode?.type);
      console.log('AST has errors:', tree.rootNode?.hasError);
      console.groupEnd();
      
      if (wasReparsed) tree.delete();
      continue;
    }

    matches.forEach(match => {
      const captureMap: Record<string, any> = {};
      match.captures.forEach(c => captureMap[c.name] = c.node);

      if (captureMap['import']) {
        const sourceNode = captureMap['import.source'];
        if (!sourceNode) {
          if (import.meta.env.DEV) {
            console.log(`⚠️ Import captured but no source node in ${file.path}`);
          }
          return;
        }

        // Clean path (remove quotes)
        const rawImportPath = sourceNode.text.replace(/['"]/g, '');
        totalImportsFound++;
        
        // Removed verbose per-import logging
        
        // Resolve to actual file in the system
        const resolvedPath = resolveImportPath(
          file.path,
          rawImportPath,
          allFilePaths,
          allFileList,
          resolveCache
        );

        if (resolvedPath) {
          // A. Update Graph (File -> IMPORTS -> File)
          const sourceId = generateId('File', file.path);
          const targetId = generateId('File', resolvedPath);
          const relId = generateId('IMPORTS', `${file.path}->${resolvedPath}`);

          totalImportsResolved++;

          graph.addRelationship({
            id: relId,
            sourceId,
            targetId,
            type: 'IMPORTS',
            confidence: 1.0,
            reason: '',
          });

          // B. Update Import Map (For Pass 4)
          // Store all resolved import paths for this file
          if (!importMap.has(file.path)) {
            importMap.set(file.path, new Set());
          }
          importMap.get(file.path)!.add(resolvedPath);
        }
      }

      // ---- Language-specific call-as-import routing (Ruby require, etc.) ----
      if (captureMap['call']) {
        const callNameNode = captureMap['call.name'];
        if (callNameNode) {
          const callRouter = callRouters[language];
          const routed = callRouter(callNameNode.text, captureMap['call']);
          if (routed && routed.kind === 'import') {
            totalImportsFound++;
            const resolvedPath = resolveImportPath(
              file.path, routed.importPath, allFilePaths, allFileList, resolveCache
            );
            if (resolvedPath) {
              const sourceId = generateId('File', file.path);
              const targetId = generateId('File', resolvedPath);
              const relId = generateId('IMPORTS', `${file.path}->${resolvedPath}`);
              totalImportsResolved++;
              graph.addRelationship({
                id: relId, sourceId, targetId,
                type: 'IMPORTS', confidence: 1.0, reason: '',
              });
              if (!importMap.has(file.path)) {
                importMap.set(file.path, new Set());
              }
              importMap.get(file.path)!.add(resolvedPath);
            }
          }
        }
      }
    });

    // If re-parsed just for this, delete the tree to save memory
    if (wasReparsed) {
      tree.delete();
    }
  }
  
  if (import.meta.env.DEV) {
    console.log(`📊 Import processing complete: ${totalImportsResolved}/${totalImportsFound} imports resolved to graph edges`);
  }
};


