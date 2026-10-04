import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkTypes, collectDiagnostics, parseDiagnostics, summarize } from './typecheck-tests.mjs';

test('parses multiline errors, normalizes dependency paths and retains repeated errors', () => {
  const output = [
    'test/a.test.ts(5,7): error TS2322: Type is not assignable.',
    '  See import("/other/checkout/node_modules/example/index").Value.',
    'test/a.test.ts(50,7): error TS2322: Type is not assignable.',
    '  See import("/other/checkout/node_modules/example/index").Value.',
  ].join('\r\n');
  const diagnostics = parseDiagnostics(output, process.cwd());
  assert.equal(
    diagnostics[0].message,
    'Type is not assignable.\n  See import("<node_modules>/example/index").Value.',
  );
  assert.equal(summarize(diagnostics)[0].count, 2);
  const literalMessage = String.raw`Type 'a\b' is not assignable to type 'a/b'.`;
  assert.equal(
    parseDiagnostics(`test/a.ts(1,1): error TS2322: ${literalMessage}`, process.cwd())[0].message,
    literalMessage,
  );
  const localDependency = output.replaceAll('/other/checkout', process.cwd());
  assert.deepEqual(parseDiagnostics(localDependency, process.cwd()), diagnostics);
  assert.deepEqual(
    parseDiagnostics(output.replaceAll('/other/checkout', 'C:\\checkout'), process.cwd()),
    diagnostics,
  );
  assert.throws(() => parseDiagnostics('error TS18003: No inputs were found.', process.cwd()));
  assert.throws(() => parseDiagnostics('unexpected compiler output', process.cwd()));
});

test('the real compiler catches a missing rank, excludes parser fixtures and only shrinks debt', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-test-types-'));
  try {
    mkdirSync(path.join(root, 'test/fixtures'), { recursive: true });
    mkdirSync(path.join(root, 'src'));
    const projectPath = path.join(root, 'tsconfig.test.json');
    const baselinePath = path.join(root, 'baseline.json');
    const testPath = path.join(root, 'test/augmentation.test.ts');
    const checkedInConfig = JSON.parse(
      readFileSync(new URL('../tsconfig.test.json', import.meta.url), 'utf8'),
    );
    writeFileSync(
      projectPath,
      JSON.stringify({
        compilerOptions: { noEmit: true, skipLibCheck: true, types: [], target: 'ES2022' },
        include: checkedInConfig.include,
        exclude: checkedInConfig.exclude,
      }),
    );
    writeFileSync(
      path.join(root, 'test/fixtures/parser-input.ts'),
      'this is deliberately invalid TypeScript !!!',
    );
    const contract =
      'interface BM25SearchResult { filePath: string; score: number; rank: number; nodeIds: string[] }\n';
    const broken =
      'const results: BM25SearchResult[] = [{ filePath: "a.ts", score: 1, nodeIds: [] }];\n';
    writeFileSync(testPath, contract + broken);
    const emptyBaseline = JSON.stringify({ version: 1, diagnostics: [] });
    writeFileSync(baselinePath, emptyBaseline);
    assert.equal(checkTypes({ projectPath, baselinePath }), 1);
    assert.equal(checkTypes({ projectPath, baselinePath, updateBaseline: true }), 1);
    assert.equal(readFileSync(baselinePath, 'utf8'), emptyBaseline);
    const diagnostics = collectDiagnostics(projectPath);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /rank/);
    writeFileSync(
      baselinePath,
      JSON.stringify({ version: 1, diagnostics: summarize(diagnostics) }),
    );
    assert.equal(checkTypes({ projectPath, baselinePath }), 0);
    // Moving lines preserves identities; adding the same error consumes a
    // second occurrence and fails even though its message already exists.
    writeFileSync(testPath, '\n\n' + contract + broken);
    assert.equal(checkTypes({ projectPath, baselinePath }), 0);
    writeFileSync(testPath, contract + broken + broken.replace('results', 'moreResults'));
    assert.equal(checkTypes({ projectPath, baselinePath }), 1);
    writeFileSync(testPath, contract + broken.replace('score: 1,', 'score: 1, rank: 1,'));
    assert.equal(checkTypes({ projectPath, baselinePath }), 1);
    assert.equal(checkTypes({ projectPath, baselinePath, updateBaseline: true }), 0);
    assert.deepEqual(JSON.parse(readFileSync(baselinePath, 'utf8')), {
      version: 1,
      diagnostics: [],
    });
    assert.equal(checkTypes({ projectPath, baselinePath }), 0);
    // Source diagnostics and broken compiler configuration must also fail.
    writeFileSync(path.join(root, 'src/main.ts'), 'const invalid: number = "no";');
    assert.equal(checkTypes({ projectPath, baselinePath }), 1);
    writeFileSync(projectPath, '{ invalid json');
    assert.equal(checkTypes({ projectPath, baselinePath }), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects corrupt baselines before running the compiler', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-type-baseline-'));
  try {
    const baselinePath = path.join(root, 'baseline.json');
    const entry = { file: 'test/a.ts', code: 2322, message: 'Example error', count: 1 };
    for (const diagnostics of [
      [{ ...entry, count: -1 }],
      [{ ...entry, file: 'src/a.ts' }],
      [entry, entry],
    ]) {
      writeFileSync(baselinePath, JSON.stringify({ version: 1, diagnostics }));
      assert.throws(
        () => checkTypes({ projectPath: path.join(root, 'absent.json'), baselinePath }),
        /baseline entry/,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
