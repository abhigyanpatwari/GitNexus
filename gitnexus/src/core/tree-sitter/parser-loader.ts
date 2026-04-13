import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Java from 'tree-sitter-java';
import C from 'tree-sitter-c';
import CPP from 'tree-sitter-cpp';
import CSharp from 'tree-sitter-c-sharp';
import Go from 'tree-sitter-go';
import Rust from 'tree-sitter-rust';
import PHP from 'tree-sitter-php';
import Ruby from 'tree-sitter-ruby';
import { createRequire } from 'node:module';
import { SupportedLanguages } from 'gitnexus-shared';

/**
 * Load an optional tree-sitter grammar, handling both CommonJS and ESM modules.
 * ESM modules with top-level await cannot be loaded via createRequire(), so we
 * fall back to dynamic import() for those cases.
 */
async function tryLoadGrammar(packageName: string): Promise<any> {
  const _require = createRequire(import.meta.url);
  try {
    return _require(packageName);
  } catch (err: any) {
    if (err?.code === 'ERR_REQUIRE_ASYNC_MODULE') {
      // Handle ESM modules with top-level await (e.g. @ganezdragon/tree-sitter-perl v1.1.1)
      try {
        const mod = await import(packageName);

        // For @ganezdragon/tree-sitter-perl, use directly without ESM wrapper
        if (packageName === '@ganezdragon/tree-sitter-perl') {
          return mod.default || mod;
        }

        // ESM modules should be used directly without unwrapping default export
        return mod.default;
      } catch {
        return null;
      }
    }
    return null;
  }
}

// Load optional dependencies — may not be installed or may be ESM modules
const Swift: any = await tryLoadGrammar('tree-sitter-swift');
const Dart: any = await tryLoadGrammar('tree-sitter-dart');
const Kotlin: any = await tryLoadGrammar('tree-sitter-kotlin');
const Perl: any = await tryLoadGrammar('@ganezdragon/tree-sitter-perl');

let parser: Parser | null = null;

const languageMap: Record<string, any> = {
  [SupportedLanguages.JavaScript]: JavaScript,
  [SupportedLanguages.TypeScript]: TypeScript.typescript,
  [`${SupportedLanguages.TypeScript}:tsx`]: TypeScript.tsx,
  [SupportedLanguages.Python]: Python,
  [SupportedLanguages.Java]: Java,
  [SupportedLanguages.C]: C,
  [SupportedLanguages.CPlusPlus]: CPP,
  [SupportedLanguages.CSharp]: CSharp,
  [SupportedLanguages.Go]: Go,
  [SupportedLanguages.Rust]: Rust,
  ...(Kotlin ? { [SupportedLanguages.Kotlin]: Kotlin } : {}),
  [SupportedLanguages.PHP]: PHP.php_only,
  [SupportedLanguages.Ruby]: Ruby,
  ...(Perl ? { [SupportedLanguages.Perl]: Perl } : {}),
  [SupportedLanguages.Vue]: TypeScript.typescript,
  ...(Dart ? { [SupportedLanguages.Dart]: Dart } : {}),
  ...(Swift ? { [SupportedLanguages.Swift]: Swift } : {}),
};

export const isLanguageAvailable = (language: SupportedLanguages): boolean =>
  language in languageMap;

export const loadParser = async (): Promise<Parser> => {
  if (parser) return parser;
  parser = new Parser();
  return parser;
};

export const loadLanguage = async (
  language: SupportedLanguages,
  filePath?: string,
): Promise<void> => {
  if (!parser) await loadParser();
  const key =
    language === SupportedLanguages.TypeScript && filePath?.endsWith('.tsx')
      ? `${language}:tsx`
      : language;

  const lang = languageMap[key];
  if (!lang) {
    throw new Error(`Unsupported language: ${language}`);
  }
  parser!.setLanguage(lang);
};
