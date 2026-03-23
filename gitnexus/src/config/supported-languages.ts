/**
 * HOW TO ADD A NEW LANGUAGE:
 *
 * 1. Add the enum member below (e.g., Scala = 'scala')
 * 2. Run `tsc --noEmit` — compiler errors guide you to every dispatch table
 * 3. Use this checklist for each file:
 *
 *    FILE                              | WHAT TO ADD                              | DEFAULT (simple languages)
 *    ----------------------------------|------------------------------------------|---------------------------
 *    tree-sitter-queries.ts            | Query string + LANGUAGE_QUERIES entry    | (required)
 *    export-detection.ts               | ExportChecker function + table entry     | (required)
 *    import-resolution.ts              | Resolver in importResolvers              | resolveStandard(...)
 *    import-resolution.ts              | namedBindingExtractors entry             | undefined
 *    call-routing.ts                   | callRouters entry                        | noRouting
 *    entry-point-scoring.ts            | ENTRY_POINT_PATTERNS entry               | []
 *    framework-detection.ts            | AST_FRAMEWORK_PATTERNS entry             | []
 *    type-extractors/<lang>.ts         | New file + index.ts import               | (required)
 *    resolvers/<lang>.ts               | Resolver file (if non-standard)          | (only if resolveStandard insufficient)
 *    named-binding-extraction.ts       | Extractor (if named imports)             | (only if language has named imports)
 *
 * 4. Also check these files for language-specific if-checks (no compile-time guard):
 *    - mro-processor.ts (MRO strategy selection)
 *    - heritage-processor.ts (extends/implements handling)
 *    - parse-worker.ts (AST edge cases)
 *    - parsing-processor.ts (node label normalization)
 *
 * 5. Add tree-sitter-<lang> to package.json dependencies
 * 6. Add file extension mapping in utils.ts getLanguageFromFilename()
 * 7. Run full test suite
 */
export enum SupportedLanguages {
    JavaScript = 'javascript',
    TypeScript = 'typescript',
    Python = 'python',
    Java = 'java',
    C = 'c',
    CPlusPlus = 'cpp',
    CSharp = 'csharp',
    Go = 'go',
    Ruby = 'ruby',
    Rust = 'rust',
    PHP = 'php',
    Kotlin = 'kotlin',
    Swift = 'swift',
}