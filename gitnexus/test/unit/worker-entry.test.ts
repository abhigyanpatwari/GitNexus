import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveParseWorkerUrl } from '../../src/core/ingestion/workers/worker-entry.js';

describe('parse worker entry selection', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function fixture() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'worker-entry-'));
    roots.push(root);
    const url = (relative: string) => pathToFileURL(path.join(root, relative));
    const write = (relative: string) => {
      const target = path.join(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, 'throw new Error("must not evaluate worker during selection");');
      return url(relative);
    };
    return { url, write, entry: url('src/core/ingestion/pipeline-phases/parse-impl.ts').href };
  }
  it('uses the adjacent worker first without evaluating either candidate', () => {
    const f = fixture();
    const adjacent = f.write('src/core/ingestion/workers/parse-worker.js');
    f.write('dist/core/ingestion/workers/parse-worker.js');
    expect(resolveParseWorkerUrl(f.entry)).toEqual(adjacent);
  });
  it('falls back from source to the installed compiled worker', () => {
    const f = fixture();
    const compiled = f.write('dist/core/ingestion/workers/parse-worker.js');
    expect(resolveParseWorkerUrl(f.entry)).toEqual(compiled);
  });
  it('preserves the missing adjacent URL so worker creation retains its existing failure', () => {
    const f = fixture();
    expect(resolveParseWorkerUrl(f.entry)).toEqual(
      f.url('src/core/ingestion/workers/parse-worker.js'),
    );
  });
  it('preserves explicit test worker overrides without probing them', () => {
    const f = fixture();
    const override = f.url('test/custom-worker.js');
    expect(resolveParseWorkerUrl(f.entry, override)).toBe(override);
  });
  it('selects the adjacent worker in a compiled package', () => {
    const f = fixture();
    const compiled = f.write('dist/core/ingestion/workers/parse-worker.js');
    expect(
      resolveParseWorkerUrl(f.url('dist/core/ingestion/pipeline-phases/parse-impl.js').href),
    ).toEqual(compiled);
  });
});
