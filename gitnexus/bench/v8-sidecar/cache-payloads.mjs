import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import v8 from 'node:v8';

// Read the published corpus outside the timer. The interning comparison uses
// identical, uninterned V8 payloads from either packed sections or legacy shards.
export async function loadCachePayloads(storage, { tryLoadV8Cache, loadPackedModules }) {
  let index;
  try {
    index = JSON.parse(await fs.readFile(path.join(storage, 'parse-cache/index.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const payloads = [];
  if (index?.format === 'file-results-v1') {
    assert(typeof index.version === 'string' && index.version.length > 0, 'Invalid cache identity');
    assert(Array.isArray(index.keys) && index.keys.length > 0, 'No packed cache records');
    assert.equal(new Set(index.keys).size, index.keys.length, 'Duplicate packed cache keys');
    const { loadFileResultStore, readFileResults, decodeFileResultSection } =
      await loadPackedModules();
    const store = await loadFileResultStore(path.join(storage, 'parse-cache/files'), index.version);
    assert.deepEqual(
      [...store.records.keys()].sort(),
      [...index.keys].sort(),
      'Incomplete packed cache index',
    );
    const keys = [...index.keys].sort();
    for (let offset = 0; offset < keys.length; offset += 64) {
      const batch = keys.slice(offset, offset + 64);
      const records = await readFileResults(store, batch);
      for (const key of batch) {
        const record = records.get(key);
        assert(record, `Unreadable packed cache record: ${key}`);
        for (const section of ['facts', 'scopes']) {
          // Do not pass an interning pool: both variants must do the work timed below.
          const hit = decodeFileResultSection(record[section], key, record.path, section);
          assert.equal(hit?.kind, 'hit', `Unreadable packed ${section}: ${key}`);
          payloads.push(v8.serialize(hit.value));
        }
      }
    }
    return { format: index.format, payloads };
  }
  assert(index?.format === undefined, 'Unsupported cache format');
  const files = [];
  for (const directory of ['parse-cache', 'parsedfile-cache']) {
    const full = path.join(storage, directory);
    let names;
    try {
      names = await fs.readdir(full, { recursive: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      continue;
    }
    files.push(
      ...names.filter((name) => name.endsWith('.v8')).map((name) => path.join(full, name)),
    );
  }
  assert(files.length > 0, 'No real V8 shards were measured');
  for (const filename of files.sort()) {
    const hit = await tryLoadV8Cache(filename);
    assert.equal(hit?.kind, 'hit', 'Unreadable baseline shard');
    payloads.push(v8.serialize(hit.value));
  }
  return { format: 'legacy-v8', payloads };
}
