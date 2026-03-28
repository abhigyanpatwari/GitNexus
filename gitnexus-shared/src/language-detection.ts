/**
 * Language Detection — maps file paths to SupportedLanguages enum values.
 *
 * Shared between CLI (ingestion pipeline) and web (syntax highlighting).
 *
 * ADDING A NEW LANGUAGE:
 * 1. Add enum member to SupportedLanguages in languages.ts
 * 2. Add file extensions to EXTENSION_MAP below
 * 3. TypeScript will error if you miss either step (exhaustive Record)
 */

import { SupportedLanguages } from './languages.js';

/** Ruby extensionless filenames recognised as Ruby source */
const RUBY_EXTENSIONLESS_FILES = new Set([
  'Rakefile',
  'Gemfile',
  'Guardfile',
  'Vagrantfile',
  'Brewfile',
]);

/**
 * Exhaustive map: every SupportedLanguages member → its file extensions.
 *
 * If a new language is added to the enum without adding an entry here,
 * TypeScript emits a compile error: "Property 'NewLang' is missing in type..."
 */
const EXTENSION_MAP: Record<SupportedLanguages, readonly string[]> = {
  [SupportedLanguages.JavaScript]: ['.js', '.jsx', '.mjs', '.cjs'],
  [SupportedLanguages.TypeScript]: ['.ts', '.tsx', '.mts', '.cts'],
  [SupportedLanguages.Python]: ['.py'],
  [SupportedLanguages.Java]: ['.java'],
  [SupportedLanguages.C]: ['.c'],
  [SupportedLanguages.CPlusPlus]: ['.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx', '.hh'],
  [SupportedLanguages.CSharp]: ['.cs'],
  [SupportedLanguages.Go]: ['.go'],
  [SupportedLanguages.Ruby]: ['.rb', '.rake', '.gemspec'],
  [SupportedLanguages.Rust]: ['.rs'],
  [SupportedLanguages.PHP]: ['.php', '.phtml', '.php3', '.php4', '.php5', '.php8'],
  [SupportedLanguages.Kotlin]: ['.kt', '.kts'],
  [SupportedLanguages.Swift]: ['.swift'],
  [SupportedLanguages.Dart]: ['.dart'],
  [SupportedLanguages.Cobol]: ['.cbl', '.cob', '.cpy', '.cobol'],
} satisfies Record<SupportedLanguages, readonly string[]>; // Ensure exhaustiveness

/** Pre-built reverse lookup: extension → language (built once at module load). */
const extToLang = new Map<string, SupportedLanguages>();
for (const [lang, exts] of Object.entries(EXTENSION_MAP) as [
  SupportedLanguages,
  readonly string[],
][]) {
  for (const ext of exts) {
    extToLang.set(ext, lang);
  }
}

/**
 * Map file extension to SupportedLanguage enum.
 * Returns null if the file extension is not recognized.
 */
export const getLanguageFromFilename = (filename: string): SupportedLanguages | null => {
  // Fast path: check the extension map
  const lastDot = filename.lastIndexOf('.');
  if (lastDot >= 0) {
    const ext = filename.slice(lastDot).toLowerCase();
    const lang = extToLang.get(ext);
    if (lang !== undefined) return lang;
  }

  // Ruby extensionless files (Rakefile, Gemfile, etc.)
  const basename = filename.split('/').pop() || filename;
  if (RUBY_EXTENSIONLESS_FILES.has(basename)) {
    return SupportedLanguages.Ruby;
  }

  return null;
};

/**
 * Exhaustive map: every SupportedLanguages member → Prism syntax identifier.
 *
 * If a new language is added to the enum without adding an entry here,
 * TypeScript emits a compile error.
 */
const SYNTAX_MAP: Record<SupportedLanguages, string> = {
  [SupportedLanguages.JavaScript]: 'javascript',
  [SupportedLanguages.TypeScript]: 'typescript',
  [SupportedLanguages.Python]: 'python',
  [SupportedLanguages.Java]: 'java',
  [SupportedLanguages.C]: 'c',
  [SupportedLanguages.CPlusPlus]: 'cpp',
  [SupportedLanguages.CSharp]: 'csharp',
  [SupportedLanguages.Go]: 'go',
  [SupportedLanguages.Ruby]: 'ruby',
  [SupportedLanguages.Rust]: 'rust',
  [SupportedLanguages.PHP]: 'php',
  [SupportedLanguages.Kotlin]: 'kotlin',
  [SupportedLanguages.Swift]: 'swift',
  [SupportedLanguages.Dart]: 'dart',
  [SupportedLanguages.Cobol]: 'cobol',
} satisfies Record<SupportedLanguages, string>; // Ensure exhaustiveness

/** Non-code file extensions → Prism-compatible syntax identifiers */
const AUXILIARY_SYNTAX_MAP: Record<string, string> = {
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  mdx: 'markdown',
  html: 'markup',
  htm: 'markup',
  erb: 'markup',
  xml: 'markup',
  css: 'css',
  scss: 'css',
  sass: 'css',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  toml: 'toml',
  ini: 'ini',
  dockerfile: 'docker',
};

/** Extensionless filenames → Prism-compatible syntax identifiers */
const AUXILIARY_BASENAME_MAP: Record<string, string> = {
  Makefile: 'makefile',
  Dockerfile: 'docker',
};

/**
 * Map file path to a Prism-compatible syntax highlight language string.
 * Covers all SupportedLanguages (code files) plus common non-code formats.
 * Returns 'text' for unrecognised files.
 */
export const getSyntaxLanguageFromFilename = (filePath: string): string => {
  const lang = getLanguageFromFilename(filePath);
  if (lang) return SYNTAX_MAP[lang];
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (ext && ext in AUXILIARY_SYNTAX_MAP) return AUXILIARY_SYNTAX_MAP[ext];
  const basename = filePath.split('/').pop() || '';
  if (basename in AUXILIARY_BASENAME_MAP) return AUXILIARY_BASENAME_MAP[basename];
  return 'text';
};
