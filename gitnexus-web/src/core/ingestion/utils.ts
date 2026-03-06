import { SupportedLanguages } from '../../config/supported-languages';

/** Ruby extensionless filenames recognised as Ruby source */
const RUBY_EXTENSIONLESS_FILES = new Set(['Rakefile', 'Gemfile', 'Guardfile', 'Vagrantfile', 'Brewfile']);

/**
 * Map file extension to SupportedLanguage enum
 */
export const getLanguageFromFilename = (filename: string): SupportedLanguages | null => {
  // TypeScript (including TSX)
  if (filename.endsWith('.tsx')) return SupportedLanguages.TypeScript;
  if (filename.endsWith('.ts')) return SupportedLanguages.TypeScript;
  // JavaScript (including JSX)
  if (filename.endsWith('.jsx')) return SupportedLanguages.JavaScript;
  if (filename.endsWith('.js')) return SupportedLanguages.JavaScript;
  // Python
  if (filename.endsWith('.py')) return SupportedLanguages.Python;
  // Java
  if (filename.endsWith('.java')) return SupportedLanguages.Java;
  // C (source and headers)
  if (filename.endsWith('.c') || filename.endsWith('.h')) return SupportedLanguages.C;
  // C++ (all common extensions)
  if (filename.endsWith('.cpp') || filename.endsWith('.cc') || filename.endsWith('.cxx') ||
      filename.endsWith('.hpp') || filename.endsWith('.hxx') || filename.endsWith('.hh')) return SupportedLanguages.CPlusPlus;
  // C#
  if (filename.endsWith('.cs')) return SupportedLanguages.CSharp;
  // Go
  if (filename.endsWith('.go')) return SupportedLanguages.Go;
  // Rust
  if (filename.endsWith('.rs')) return SupportedLanguages.Rust;
  // PHP (all common extensions)
  if (filename.endsWith('.php') || filename.endsWith('.phtml') ||
      filename.endsWith('.php3') || filename.endsWith('.php4') ||
      filename.endsWith('.php5') || filename.endsWith('.php8')) {
    return SupportedLanguages.PHP;
  }
  // Ruby (extensions)
  if (filename.endsWith('.rb') || filename.endsWith('.rake') || filename.endsWith('.gemspec')) {
    return SupportedLanguages.Ruby;
  }
  // Ruby (extensionless files)
  const basename = filename.split('/').pop() || filename;
  if (RUBY_EXTENSIONLESS_FILES.has(basename)) {
    return SupportedLanguages.Ruby;
  }
  // Swift
  if (filename.endsWith('.swift')) return SupportedLanguages.Swift;
  if (filename.endsWith('.dart')) return SupportedLanguages.Dart;
  return null;
};

