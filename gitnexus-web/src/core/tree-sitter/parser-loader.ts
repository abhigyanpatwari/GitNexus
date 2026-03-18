import Parser from 'web-tree-sitter';
import { SupportedLanguages } from '../../config/supported-languages';

let parser: Parser | null = null;

// Cache the compiled Language objects to avoid fetching/compiling twice
const languageCache = new Map<string, Parser.Language>();

export const loadParser = async (): Promise<Parser> => {
    if (parser) return parser;

    await Parser.init({
        locateFile: (scriptName: string) => {
            return `/wasm/${scriptName}`;
        }
    })

    parser = new Parser();
    return parser;
}

// Get the appropriate WASM file based on language and file extension
const getWasmPath = (language: SupportedLanguages, filePath?: string): string => {
    // For TypeScript, check if it's a TSX file
    if (language === SupportedLanguages.TypeScript) {
        if (filePath?.endsWith('.tsx')) {
            return '/wasm/typescript/tree-sitter-tsx.wasm';
        }
        return '/wasm/typescript/tree-sitter-typescript.wasm';
    }
    
    const languageFileMap: Record<SupportedLanguages, string> = {
        [SupportedLanguages.JavaScript]: '/wasm/javascript/tree-sitter-javascript.wasm',
        [SupportedLanguages.TypeScript]: '/wasm/typescript/tree-sitter-typescript.wasm',
        [SupportedLanguages.Python]: '/wasm/python/tree-sitter-python.wasm',
        [SupportedLanguages.Java]: '/wasm/java/tree-sitter-java.wasm',
        [SupportedLanguages.C]: '/wasm/c/tree-sitter-c.wasm',
        [SupportedLanguages.CPlusPlus]: '/wasm/cpp/tree-sitter-cpp.wasm',
        [SupportedLanguages.CSharp]: '/wasm/csharp/tree-sitter-csharp.wasm',
        [SupportedLanguages.Go]: '/wasm/go/tree-sitter-go.wasm',
        [SupportedLanguages.Rust]: '/wasm/rust/tree-sitter-rust.wasm',
        [SupportedLanguages.PHP]: '/wasm/php/tree-sitter-php.wasm',
        [SupportedLanguages.Ruby]: '/wasm/ruby/tree-sitter-ruby.wasm',
        [SupportedLanguages.Kotlin]: '', // Kotlin WASM parser not yet available for web
        [SupportedLanguages.Swift]: '/wasm/swift/tree-sitter-swift.wasm',
    };
    
    return languageFileMap[language];
};

export const loadLanguage = async (language: SupportedLanguages, filePath?: string): Promise<void> => {
    if (!parser) await loadParser();
    const wasmPath = getWasmPath(language, filePath);
    
    if (languageCache.has(wasmPath)) {
        parser!.setLanguage(languageCache.get(wasmPath)!);
        return;
    }

    if (!wasmPath) {
        console.error(`❌ [Parser] No WASM path configured for language: ${language}`);
        throw new Error(`Unsupported language: ${language}`);
    }
    
    try {
        const loadedLanguage = await Parser.Language.load(wasmPath);    
        languageCache.set(wasmPath, loadedLanguage);
        parser!.setLanguage(loadedLanguage);
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`❌ [Parser] Failed to load WASM grammar for ${language}`);
        console.error(`   WASM Path: ${wasmPath}`);
        console.error(`   Error: ${errorMessage}`);
        throw new Error(`Failed to load grammar for ${language}: ${errorMessage}`);
    }
}
