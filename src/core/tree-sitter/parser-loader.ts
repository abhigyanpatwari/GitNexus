
// Import tree-sitter explicitly to ensure Vite pre-optimizes it
import Parser from "web-tree-sitter";

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
          return `/wasm/${scriptName}`;
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
    const wasmPath = '/wasm/python/tree-sitter-python.wasm';
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
