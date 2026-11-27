// Run from gitnexus/ after npm run build: node bench/python-resource-lifetime/measure.mjs
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { getPythonParser } from '../../dist/core/ingestion/languages/python/query.js';
import { pythonResourceLifetime } from '../../dist/core/ingestion/languages/python/resource-lifetime.js';

const parser = getPythonParser();
for (const functions of [100, 1000, 5000]) {
  const cases = Array.from({ length: functions }, (_, i) =>
    i % 2 === 0
      ? `def session_${i}():\n    db = connect()\n    try:\n        yield db\n    finally:\n        db.close()\n`
      : `def opaque_${i}():\n    return borrow()\n`,
  );
  const source = cases.join('\n');
  const tree = parser.parse(source, undefined, { bufferSize: Buffer.byteLength(source) + 1024 });
  const definitions = tree.rootNode.namedChildren;
  const samples = [];
  for (let round = 0; round < 8; round++) {
    let facts = 0;
    const start = performance.now();
    for (const fn of definitions) if (pythonResourceLifetime(fn)) facts++;
    const elapsed = performance.now() - start;
    assert.equal(facts, functions / 2);
    if (round > 0) samples.push(elapsed);
  }
  samples.sort((a, b) => a - b);
  console.log(JSON.stringify({ functions, facts: functions / 2, medianMs: samples[3] }));
}
