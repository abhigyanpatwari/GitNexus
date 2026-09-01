import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isTestFilePath } from '../../src/core/ingestion/utils/test-file-path.js';
import { isTestFile } from '../../src/core/ingestion/entry-point-scoring.js';
import { isTestFilePath as backendIsTestFilePath } from '../../src/mcp/local/local-backend.js';

describe('isTestFilePath — shared predicate', () => {
  it('returns false for nullish input rather than throwing', () => {
    expect(isTestFilePath(undefined)).toBe(false);
    expect(isTestFilePath(null)).toBe(false);
    expect(isTestFilePath('')).toBe(false);
  });

  it('normalizes Windows separators and casing', () => {
    expect(isTestFilePath('SRC\\Test\\FooTests.cs')).toBe(true);
    expect(isTestFilePath('pkg\\thing_test.go')).toBe(true);
  });

  // These were recognized by entry-point scoring but NOT by the MCP copy, so
  // `includeTests: false` silently failed to filter them.
  for (const p of [
    'app/src/test/java/com/x/FooTest.java',
    'ios/MyAppTests/LoginTests.swift',
    'ios/MyAppUITests/FlowTest.swift',
    'src/Widgets.Tests/WidgetTests.cs',
    'src/Widgets.UnitTests/Thing.cs',
    'src/Widgets.IntegrationTests/Thing.cs',
    'tests/Feature/LoginTest.php',
    'tests/Unit/ThingSpec.php',
  ]) {
    it(`detects a test path the MCP copy used to miss: ${p}`, () => {
      expect(isTestFilePath(p)).toBe(true);
    });
  }

  // These were recognized by the MCP copy but NOT by entry-point scoring, so
  // they could be selected as process entry points.
  for (const p of ['pkg/fixtures/sample.py', 'tests/conftest.py']) {
    it(`detects a test path entry-point scoring used to miss: ${p}`, () => {
      expect(isTestFilePath(p)).toBe(true);
    });
  }

  for (const p of [
    'src/app/widgets.ts',
    'src/core/ingestion/utils/test-file-path.ts',
    'pkg/service/handler.go',
    'app/models/user.rb',
  ]) {
    it(`does not classify production code as test: ${p}`, () => {
      expect(isTestFilePath(p)).toBe(false);
    });
  }
});

describe('test-file classification has exactly one implementation', () => {
  // Regression guard: two hand-maintained copies drifted apart once already.
  // Both public names must delegate to the same predicate.
  const paths = [
    'src/app/widgets.ts',
    'app/src/test/java/com/x/FooTest.java',
    'ios/MyAppTests/LoginTests.swift',
    'src/Widgets.Tests/WidgetTests.cs',
    'tests/conftest.py',
    'pkg/fixtures/sample.py',
    'spec/models/user_spec.rb',
    'pkg/thing_test.go',
    'tests/Feature/LoginTest.php',
  ];

  it('entry-point-scoring isTestFile agrees with the shared predicate', () => {
    for (const p of paths) expect(isTestFile(p)).toBe(isTestFilePath(p));
  });

  it('local-backend isTestFilePath agrees with the shared predicate', () => {
    for (const p of paths) expect(backendIsTestFilePath(p)).toBe(isTestFilePath(p));
  });
});

describe('shared predicate stays dependency-free', () => {
  // Poka-yoke for #2802: `local-backend.ts` imports this module, so anything
  // imported here lands in MCP server startup. The duplication this module
  // replaced existed precisely because `entry-point-scoring.ts` pulls in the
  // language-provider registry. An import added here would silently reintroduce
  // that startup cost.
  it('declares no imports', () => {
    const src = readFileSync(
      new URL('../../src/core/ingestion/utils/test-file-path.ts', import.meta.url),
      'utf8',
    );
    const imports = src
      .split('\n')
      .filter((l) => /^\s*(import|export)\s.*\sfrom\s/.test(l) || /^\s*import\s*\(/.test(l));
    expect(imports).toEqual([]);
  });
});
