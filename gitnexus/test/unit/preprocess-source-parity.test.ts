import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';
import { getProvider } from '../../src/core/ingestion/languages/index.js';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';
import { ensureAndParse } from '../../src/core/embeddings/ast-utils.js';

/**
 * Every provider that defines `preprocessSource` must produce the same
 * `ParsedFile` whether it is handed raw source or already-preprocessed source.
 *
 * Only the parse worker applies the hook (`parse-worker.ts`). `emitScopeCaptures`
 * re-parses on a parse-cache miss, so unless each emitter re-applies the
 * transform the two halves of the pipeline analyze different programs and the
 * graph depends on whether the run was warm or cold (#2771).
 */
const PREPROCESSED_LANGUAGES = [
  {
    language: SupportedLanguages.Swift,
    filePath: 'Fixture.swift',
    source: [
      'class Outer {',
      '  enum A { case x }',
      '  #if os(iOS)',
      '  enum B { case y }',
      '  #endif',
      '}',
      '',
    ].join('\n'),
  },
  {
    language: SupportedLanguages.CPlusPlus,
    filePath: 'Actor.cpp',
    source: [
      'UCLASS()',
      'class MYGAME_API AGameActor : public AActor {',
      '  GENERATED_BODY()',
      'public:',
      '  UPROPERTY(EditAnywhere) int Health;',
      '  UFUNCTION(BlueprintCallable) void Tick(float DeltaTime) { Health = 1; }',
      '};',
      '',
    ].join('\n'),
  },
  {
    language: SupportedLanguages.Dart,
    filePath: 'meters.dart',
    source: ['extension type Meters(int value) {', '  int get raw => value;', '}', ''].join('\n'),
  },
] as const;

describe('LanguageProvider.preprocessSource parity', () => {
  describe.each(PREPROCESSED_LANGUAGES)('$language', ({ language, filePath, source }) => {
    it.skipIf(!isLanguageAvailable(language))(
      'extracts the same ParsedFile from raw and preprocessed source',
      () => {
        const provider = getProvider(language);
        const preprocessed = provider.preprocessSource?.(source, filePath) ?? source;

        expect(preprocessed).not.toBe(source);
        expect(preprocessed).toHaveLength(source.length);
        expect(extractParsedFile(provider, source, filePath, () => {})).toEqual(
          extractParsedFile(provider, preprocessed, filePath, () => {}),
        );
      },
    );

    it.skipIf(!isLanguageAvailable(language))(
      'parses the preprocessed text on the embedding path too',
      async () => {
        const tree = await ensureAndParse(source, filePath);

        expect(tree.rootNode.hasError).toBe(false);
      },
    );
  });
});
