/**
 * The persisted IMPORTS of `import X` must grow with what each importer
 * reaches, not with the size of X, also in modules whose types share the
 * usual member names (`id`, `name`, `title`, `data`, `value`, `shared`,
 * `default`, `none`), whose extension files extend SDK types, and whose
 * module declares a type named after itself.
 *
 * The bound pinned here, per importer and module: the files whose top-level
 * declarations it spells, plus the extension files that declare a member
 * whose name it writes anywhere, plus the files whose statics or enum cases it
 * names as implicit members. Type-body instance members are never part of it. An
 * importer that writes `.none` or `.default` therefore keeps every file that
 * declares a static or enum case of that name, on top of the files it names.
 */
import { describe, expect, it } from 'vitest';
import { useFixture } from './helpers.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import { emitSwiftScopeCaptures } from '../../../src/core/ingestion/languages/swift/captures.js';
import { collectSwiftCaptureSideChannel } from '../../../src/core/ingestion/languages/swift/name-facts.js';
import {
  SIZE_COMMON_EXTENSIONS,
  SIZE_DTO_FILES,
  SIZE_IMPORTERS,
  SIZE_SDK_EXTENSIONS,
  SIZE_TYPES,
  sizeFixture,
  swiftImportTargets as importTargets,
} from './swift-fanout-fixtures.js';

const swiftAvailable = isLanguageAvailable(SupportedLanguages.Swift);

describe.skipIf(!swiftAvailable)('Swift import X: kept edges are bounded by use', () => {
  const result = useFixture('swift-fanout-size', sizeFixture(), 120000);

  it('keeps, for an importer that spells what it uses, only the files it reaches', () => {
    const targets = importTargets(result());
    for (let k = 0; k < SIZE_IMPORTERS; k++) {
      const t = k % SIZE_TYPES;
      const commonNames = Array.from(
        { length: SIZE_COMMON_EXTENSIONS },
        (_, n) => `Core/${n % 2 === 0 ? 'String' : 'UIView'}+E${n}.swift`,
      );
      const called = `Core/String+E${(2 * k) % SIZE_SDK_EXTENSIONS}.swift`;
      expect(targets.get(`App/Spelled${k}.swift`)).toEqual(
        [
          ...new Set([
            `Core/Type${t}.swift`,
            called,
            ...commonNames,
            'DTO/DTO.swift',
            `DTO/Model${k % SIZE_DTO_FILES}.swift`,
          ]),
        ].sort(),
      );
    }
  });

  it('adds, for an importer that also writes implicit members, the files declaring those names', () => {
    // A by-name match cannot tell `.none` of Optional from a module enum's
    // `case none`, so every file declaring a static or enum case named
    // `none` or `default` stays: here every Type file. The bound is those
    // files plus the files the importer names; the SDK extension files,
    // which declare neither, are never kept.
    const declaringImplicitNames = Array.from(
      { length: SIZE_TYPES },
      (_, i) => `Core/Type${i}.swift`,
    );
    const targets = importTargets(result());
    for (let k = 0; k < SIZE_IMPORTERS; k++) {
      const spelled = `Core/Type${k % SIZE_TYPES}.swift`;
      expect(targets.get(`App/Implicit${k}.swift`)).toEqual(
        [...new Set([spelled, ...declaringImplicitNames])].sort(),
      );
    }
  });

  it('reads every file of the fixture: no declarations are unknown', () => {
    const unknown: Record<string, number> = {};
    for (const [filePath, source] of Object.entries(sizeFixture())) {
      emitSwiftScopeCaptures(source, filePath);
      const reason = collectSwiftCaptureSideChannel(filePath)?.nameFacts.unknown;
      if (reason !== undefined) unknown[reason] = (unknown[reason] ?? 0) + 1;
    }
    expect(unknown).toEqual({});
  });

  it('never keeps a file for a type-body instance member name', () => {
    // Every importer reads `id`, `name`, `title`, `data` and `value`, which
    // every Type file declares; only the spelled type's file is kept.
    const kept = [...importTargets(result()).entries()].filter(([file]) =>
      file.startsWith('App/Spelled'),
    );
    for (const [, files] of kept)
      expect(files.filter((file) => file.startsWith('Core/Type'))).toHaveLength(1);
  });
});
