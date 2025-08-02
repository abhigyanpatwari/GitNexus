// @ts-expect-error - npm: imports are resolved at runtime in Deno
import Parser from "npm:web-tree-sitter";

interface Language {
  [key: string]: unknown;
}

let parserInstance: Parser | null = null;
const parserCache = new Map<string, Language>();

export async function initTreeSitter(): Promise<Parser> {
  if (parserInstance) return parserInstance;
  
  // Initialize WebAssembly
  await Parser.init();
  parserInstance = new Parser();
  return parserInstance;
}

export async function loadPythonParser(): Promise<Language> {
  if (parserCache.has('python')) {
    return parserCache.get('python')!;
  }
  
  // Load Python language from WASM file
  const pythonLang = await Parser.Language.load('/wasm/python/tree-sitter-python.wasm');
  
  parserCache.set('python', pythonLang);
  return pythonLang;
} 