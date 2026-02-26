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
import Julia from 'tree-sitter-julia';
import { SupportedLanguages } from '../../config/supported-languages.js';

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
  [SupportedLanguages.Julia]: Julia,
};

export const loadParser = async (): Promise<Parser> => {
  if (parser) return parser;
  parser = new Parser();
  return parser;
};

export const loadLanguage = async (language: SupportedLanguages, filePath?: string): Promise<void> => {
  if (!parser) await loadParser();
  const key = language === SupportedLanguages.TypeScript && filePath?.endsWith('.tsx')
    ? `${language}:tsx`
    : language;

  const lang = languageMap[key];
  if (!lang) {
    throw new Error(`Unsupported language: ${language}`);
  }
  parser!.setLanguage(lang);
};
