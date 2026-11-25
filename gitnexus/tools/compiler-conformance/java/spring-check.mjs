import { runInSequence } from '../../../test/helpers/run-in-sequence.mjs';
import { compareCodeUnits } from '../compare.mjs';
import assert from 'node:assert/strict';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const directory = new URL('./spring-checks/', import.meta.url);
const modules = globSync('*.mjs', { cwd: fileURLToPath(directory) }).sort(compareCodeUnits);
assert.ok(modules.length, 'No Spring conformance modules');
let count = 0;
await runInSequence(modules, async (module) => {
  if (process.argv.length > 2 && !process.argv.slice(2).includes(module.slice(0, -4))) return;
  const checks = Object.entries(await import(new URL(module, directory)));
  await runInSequence(checks, async ([name, verify]) => {
    try {
      await verify();
    } catch (error) {
      throw new Error(`${module} ${name}`, { cause: error });
    }
    console.log(`Spring ${module.slice(0, -4)} ${name}`);
    count++;
  });
});
assert.ok(count, 'No Spring conformance scenarios selected');
console.log(`${count} Spring framework conformance scenarios`);
