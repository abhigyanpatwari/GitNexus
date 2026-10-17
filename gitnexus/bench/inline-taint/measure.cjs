#!/usr/bin/env node
// Build-free capture/identity benchmark: node --import tsx bench/inline-taint/measure.cjs --check
// BENCH_SOURCE_ROOT selects the unmodified checkout for a before/after run.
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const Parser = require('tree-sitter');
const TS = require('tree-sitter-typescript');
const root = process.env.BENCH_SOURCE_ROOT
  ? join(resolve(process.env.BENCH_SOURCE_ROOT), 'gitnexus')
  : resolve(__dirname, '../..');

async function main() {
  const { emitTsScopeCaptures } = await import(
    pathToFileURL(join(root, 'src/core/ingestion/languages/typescript/captures.ts')).href
  );
  const report = {};
  for (const shape of ['inline', 'returned', 'named']) {
    const arms = [];
    for (const count of [96, 384]) {
      const source = Array.from({ length: count }, (_, i) =>
        shape === 'inline'
          ? `app.get('/${i}', (req) => { forward(req.query.value); });`
          : shape === 'returned'
            ? `function make${i}() { return async function handler${i}(req) { forward(req.body.value); }; }`
            : `function handler${i}(req) { forward(req.query.value); }`,
      ).join('\n');
      const parser = new Parser();
      parser.setLanguage(TS.typescript);
      const tree = parser.parse(source);
      let captures;
      const times = [];
      for (let i = 0; i < 20; i++) {
        const start = performance.now();
        captures = emitTsScopeCaptures(source, 'routes.ts', tree);
        if (i >= 5) times.push(performance.now() - start);
      }
      const identities = captures
        .filter((c) => c['@declaration.function'])
        .map((c) => [c['@declaration.name']?.text, c['@declaration.function'].range]);
      arms.push({
        units: count,
        min_ms: Math.min(...times),
        functions: identities.length,
        fingerprint: createHash('sha256').update(JSON.stringify(identities)).digest('hex'),
      });
    }
    report[shape] = {
      small: arms[0],
      large: arms[1],
      scaling: arms[1].min_ms / arms[0].min_ms / 4,
    };
  }
  const visibilityPath = join(
    root,
    'src/core/ingestion/languages/javascript/callable-visibility.ts',
  );
  if (existsSync(visibilityPath)) {
    const { isJsSelfBoundCallableFallbackPlausible } = await import(
      pathToFileURL(visibilityPath).href
    );
    const { javascriptProvider } = await import(
      pathToFileURL(join(root, 'src/core/ingestion/languages/typescript.ts')).href
    );
    const { extractParsedFile } = await import(
      pathToFileURL(join(root, 'src/core/ingestion/scope-extractor-bridge.ts')).href
    );
    const arms = [];
    for (const count of [96, 384]) {
      const source = Array.from(
        { length: count },
        (_, i) =>
          `function make${i}() { return function handler${i}(req) { sink(req.query.value); }; }`,
      ).join('\n');
      const parsed = extractParsedFile(javascriptProvider, source, 'handlers.js');
      const candidates = parsed.localDefs.filter((def) => def.qualifiedName.startsWith('handler'));
      const times = [];
      let answers;
      for (let i = 0; i < 20; i++) {
        // A new ParsedFile includes cold index construction in every sample.
        const fresh = { ...parsed };
        const start = performance.now();
        answers = candidates.map((candidate) =>
          isJsSelfBoundCallableFallbackPlausible({
            callerParsed: fresh,
            candidate,
            parsedFileOf: () => fresh,
            site: { name: candidate.qualifiedName, inScope: fresh.moduleScope },
          }),
        );
        if (i >= 5) times.push(performance.now() - start);
      }
      arms.push({
        units: count,
        min_ms: Math.min(...times),
        functions: answers.filter((answer) => !answer).length,
        fingerprint: createHash('sha256').update(JSON.stringify(answers)).digest('hex'),
      });
    }
    report.visibility = {
      small: arms[0],
      large: arms[1],
      scaling: arms[1].min_ms / arms[0].min_ms / 4,
    };
  }
  if (process.argv.includes('--check')) {
    const baseline = JSON.parse(readFileSync(join(__dirname, 'baseline.json'), 'utf8'));
    assert.deepEqual(Object.keys(report).sort(), Object.keys(baseline).sort());
    for (const [shape, arm] of Object.entries(report)) {
      const expected = baseline[shape];
      assert(
        Number.isFinite(expected.scaling_budget) && expected.scaling_budget > 0,
        'missing scaling gate',
      );
      assert(arm.scaling <= expected.scaling_budget, `${shape}: scaling ${arm.scaling}`);
      for (const size of ['small', 'large']) {
        assert.equal(arm[size].functions, expected[size].functions, `${shape}/${size}: functions`);
        assert.equal(
          arm[size].fingerprint,
          expected[size].fingerprint,
          `${shape}/${size}: identity drift`,
        );
      }
    }
  }
  console.log(JSON.stringify(report, null, 2));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
