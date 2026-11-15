// Optional instrumentation preload; discard timings from traced runs.
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { threadId } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
const root = process.env.FACT_RUNTIME_ROOT;
const target = process.env.FACT_COUNTER_LOG;
assert(root && target, 'Set FACT_RUNTIME_ROOT and FACT_COUNTER_LOG for this preload');
if (threadId === 0) writeFileSync(target, '', { flag: 'wx' });
const trees = new WeakMap(),
  arrays = new WeakMap();
let treeSerial = 0,
  arraySerial = 0;
for (const [module, prefixes] of [
  ['jvm', ['java', 'kotlin']],
  ['typescript-javascript', ['typescript', 'javascript']],
  ['csharp', ['csharp']],
  ['python', ['python']],
  ['php', ['php']],
  ['swift', ['swift']],
  ['dart', ['dart']],
]) {
  const exports = await import(
    pathToFileURL(root + '/dist/core/ingestion/method-extractors/configs/' + module + '.js')
  );
  for (const prefix of prefixes) {
    const config = exports[prefix + 'MethodConfig'];
    const original = config.extractParameters;
    config.extractParameters = function (node, ...args) {
      const result = original(node, ...args);
      if (node.tree && !trees.has(node.tree)) trees.set(node.tree, ++treeSerial);
      if (!arrays.has(result)) arrays.set(result, ++arraySerial);
      appendFileSync(
        target,
        JSON.stringify({
          thread: threadId,
          provider: prefix,
          tree: trees.get(node.tree),
          node: node.id,
          kind: node.type,
          array: arrays.get(result),
        }) + '\n',
      );
      return result;
    };
  }
}
