
import Parser from "web-tree-sitter";

let parserInstance: Parser | null = null;
const parserCache = new Map<string, Parser.Language>();

export async function initTreeSitter(): Promise<Parser> {
  if (parserInstance) return parserInstance;
  
  // Initialize WebAssembly
  await Parser.init();
  parserInstance = new Parser();
  return parserInstance;
}

export async function loadPythonParser(): Promise<Parser.Language> {
  if (parserCache.has('python')) {
    return parserCache.get('python')!;
  }
  
  // Load Python language from WASM file
  const pythonLang = await Parser.Language.load('/wasm/python/tree-sitter-python.wasm');
  
  parserCache.set('python', pythonLang);
  return pythonLang;
} 
