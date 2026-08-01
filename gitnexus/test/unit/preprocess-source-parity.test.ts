import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';
import { providers, getProvider } from '../../src/core/ingestion/languages/index.js';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';
import { ensureAndParse } from '../../src/core/embeddings/ast-utils.js';

/**
 * Every provider that defines `preprocessSource` must produce the same
 * `ParsedFile` whether it is handed raw source or already-preprocessed source.
 *
 * The parse worker applies the hook, but `emitScopeCaptures` re-parses on a
 * parse-cache miss and the embedding pipeline parses independently — so unless
 * those paths see the same transform the halves of the pipeline analyze
 * different programs and the graph depends on whether the run was warm (#2771).
 *
 * Fixtures are keyed by language and cross-checked against the registry, so a
 * new provider adopting the hook fails here until it adds one.
 */
const FIXTURES: Partial<Record<SupportedLanguages, { filePath: string; source: string }>> = {
  [SupportedLanguages.Swift]: {
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
  [SupportedLanguages.CPlusPlus]: {
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
  [SupportedLanguages.Dart]: {
    filePath: 'meters.dart',
    source: ['extension type Meters(int value) {', '  int get raw => value;', '}', ''].join('\n'),
  },
};

const languagesWithHook = Object.entries(providers)
  .filter(([, provider]) => provider.preprocessSource !== undefined)
  .map(([language]) => language)
  .sort();

describe('LanguageProvider.preprocessSource parity', () => {
  it('has a fixture for every provider defining the hook', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(languagesWithHook);
  });

  describe.each(languagesWithHook)('%s', (language) => {
    const provider = getProvider(language as SupportedLanguages);
    const { filePath, source } = FIXTURES[language as SupportedLanguages]!;

    describe.skipIf(!isLanguageAvailable(language as SupportedLanguages))('with the grammar', () => {
      it('extracts the same ParsedFile from raw and preprocessed source', () => {
        const preprocessed = provider.preprocessSource!(source, filePath);

        expect(preprocessed).not.toBe(source);
        expect(preprocessed).toHaveLength(source.length);
        expect(extractParsedFile(provider, source, filePath, () => {})).toEqual(
          extractParsedFile(provider, preprocessed, filePath, () => {}),
        );
      });

      it('parses the preprocessed text on the embedding path too', async () => {
        const tree = await ensureAndParse(source, filePath);

        expect(tree.rootNode.hasError).toBe(false);
      });
    });
  });
});
