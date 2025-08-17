// Import tree-sitter explicitly to ensure Vite pre-optimizes it
import Parser from "web-tree-sitter";

const getWasmPath = (path: string) => {
  const baseUrl = import.meta.env.BASE_URL || '/';
  const finalBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${finalBaseUrl}wasm/${path}`;
};

let parserInstance: Parser | null = null;
const parserCache = new Map<string, Parser.Language>();

export async function initTreeSitter(): Promise<Parser> {
  if (parserInstance) return parserInstance;
  
  try {
    // Initialize WebAssembly with proper configuration
    await Parser.init({
      locateFile(scriptName: string, scriptDirectory: string) {
        // Return the correct path for WASM files
        if (scriptName.endsWith('.wasm')) {
          return getWasmPath(scriptName);
        }
        return scriptDirectory + scriptName;
      }
    });
    parserInstance = new Parser();
    return parserInstance;
  } catch (error) {
    console.error('Failed to initialize Tree-sitter:', error);
    throw new Error(`Tree-sitter initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function loadPythonParser(): Promise<Parser.Language> {
  if (parserCache.has('python')) {
    return parserCache.get('python')!;
  }
  
  try {
    // Load Python language from WASM file
    const wasmPath = getWasmPath('python/tree-sitter-python.wasm');
    console.log('Loading Python parser from:', wasmPath);
    
    const pythonLang = await Parser.Language.load(wasmPath);
    
    parserCache.set('python', pythonLang);
    console.log('Python parser loaded successfully');
    return pythonLang;
  } catch (error) {
    console.error('Failed to load Python parser:', error);
    throw new Error(`Python parser loading failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function loadJavaScriptParser(): Promise<Parser.Language> {
  if (parserCache.has('javascript')) {
    return parserCache.get('javascript')!;
  }
  try {
    const wasmPath = getWasmPath('javascript/tree-sitter-javascript.wasm');
    console.log('Loading JavaScript parser from:', wasmPath);
    const jsLang = await Parser.Language.load(wasmPath);
    parserCache.set('javascript', jsLang);
    console.log('JavaScript parser loaded successfully');
    return jsLang;
  } catch (error) {
    console.error('Failed to load JavaScript parser:', error);
    throw new Error(`JavaScript parser loading failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function loadTypeScriptParser(): Promise<Parser.Language> {
  if (parserCache.has('typescript')) {
    return parserCache.get('typescript')!;
  }
  try {
    const wasmPath = getWasmPath('typescript/tree-sitter-typescript.wasm');
    console.log('Loading TypeScript parser from:', wasmPath);
    const tsLang = await Parser.Language.load(wasmPath);
    parserCache.set('typescript', tsLang);
    console.log('TypeScript parser loaded successfully');
    return tsLang;
  } catch (error) {
    console.error('Failed to load TypeScript parser:', error);
    throw new Error(`TypeScript parser loading failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function loadTsxParser(): Promise<Parser.Language> {
  if (parserCache.has('tsx')) {
    return parserCache.get('tsx')!;
  }
  try {
    const wasmPath = getWasmPath('typescript/tree-sitter-tsx.wasm');
    console.log('Loading TSX parser from:', wasmPath);
    const tsxLang = await Parser.Language.load(wasmPath);
    parserCache.set('tsx', tsxLang);
    console.log('TSX parser loaded successfully');
    return tsxLang;
  } catch (error) {
    console.error('Failed to load TSX parser:', error);
    throw new Error(`TSX parser loading failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}