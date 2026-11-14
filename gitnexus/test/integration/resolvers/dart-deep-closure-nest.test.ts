/**
 * Closures nested 48 deep, through the real parse worker and resolver
 * (#3912 review).
 *
 * The closure-binder bench found no Function nodes for its 256-function file
 * at depth 48. That is not a parser or recursion limit: tree-sitter-dart parses
 * the nest without an error, and the capture emitter opens every scope. The
 * worker spent longer than the worker pool's idle timeout on that 1.6 MB file
 * (30 s, then 60 s split, then the 150 s cumulative cap), so the pool
 * quarantined it. One function at the same depth fits easily, so this pins
 * the depth itself: the Function node exists and its CALLS edges are exactly
 * the binder rule's, with fixed-width indentation as in the bench.
 */
import { isDeepStrictEqual } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../../src/types/pipeline.js';
import {
  isLanguageAvailable,
  loadLanguage,
  loadParser,
} from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import { getRelationships, getResolutionOutcomes, writeFixtureRepo } from './helpers.js';

// The Dart grammar is optional; this suite skips where it cannot load.
let dartAvailable = isLanguageAvailable(SupportedLanguages.Dart);
if (dartAvailable) {
  try {
    await loadParser();
    await loadLanguage(SupportedLanguages.Dart);
  } catch {
    dartAvailable = false;
  }
}

const DEPTH = 48;

/** The bench's three closure kinds, rotating, each nested in the previous one. */
const KINDS = ['(cs) { cs.save();', '(Other cs) { cs.save();', '(x) { cs.run();'];

function deepNest(): string {
  let body = '';
  for (let j = 0; j < DEPTH; j++) body += `  items.forEach(${KINDS[j % KINDS.length]}\n`;
  for (let j = 0; j < DEPTH; j++) body += '  });\n';
  return `import 'types.dart';\n\nvoid f(Address cs, List<int> items) {\n${body}}\n`;
}

describe.skipIf(!dartAvailable)('Dart closures nested 48 deep', () => {
  let root = '';
  let result: PipelineResult | undefined;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-dart-deep-nest-'));
    writeFixtureRepo(root, {
      'pubspec.yaml': 'name: deep\n',
      'lib/types.dart':
        'class Address {\n  void save() {}\n  void run() {}\n}\n\n' +
        'class Other {\n  void save() {}\n  void run() {}\n}\n',
      'lib/main.dart': deepNest(),
    });
    result = await runPipelineFromRepo(root, () => {});
  }, 120000);
  afterAll(() => {
    if (root !== '') fs.rmSync(root, { recursive: true, force: true });
  });
  const run = (): PipelineResult => {
    if (result === undefined) throw new Error('pipeline did not run');
    return result;
  };

  it('keeps the Function node and resolves every call by the nearest binder', () => {
    const calls = getRelationships(run(), 'CALLS')
      .filter((edge) => edge.rel.sourceId === 'Function:lib/main.dart:f')
      .map((edge) => edge.rel.targetId)
      .sort();
    // Each `(cs)` rebinds the name untyped and declines; each `(Other cs)`
    // reaches Other.save; each `(x)` reaches the `Other cs` one level up.
    const rounds = DEPTH / KINDS.length;
    expect(
      isDeepStrictEqual(
        calls,
        [
          ...Array<string>(rounds).fill('Method:lib/types.dart:Other.run#0'),
          ...Array<string>(rounds).fill('Method:lib/types.dart:Other.save#0'),
        ].sort(),
      ),
    ).toBe(true);
    // Each untyped `(cs)` stops the walk at its own binder: one decline per
    // `cs.save()` it holds, on lines 4, 7, 10, ... of the nest.
    const untypedSaves = getResolutionOutcomes(run())
      .flatMap((outcome) =>
        outcome.kind === 'suppressed' &&
        outcome.filePath === 'lib/main.dart' &&
        outcome.name === 'save' &&
        outcome.siteKind === 'call'
          ? [
              `${outcome.reason}/${outcome.declineDetail} ${outcome.range.startLine}:${outcome.range.startCol}`,
            ]
          : [],
      )
      .sort();
    expect(
      isDeepStrictEqual(
        untypedSaves,
        Array.from(
          { length: rounds },
          (_, k) => `receiver-type-unresolved/untyped-binder ${4 + 3 * k}:26`,
        ).sort(),
      ),
    ).toBe(true);
  });
});
