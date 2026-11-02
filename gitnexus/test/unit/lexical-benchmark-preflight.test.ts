import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const harness = fileURLToPath(new URL('../../bench/lexical-lookup/measure.mjs', import.meta.url));
const scratch: string[] = [];
afterEach(() => {
  for (const root of scratch.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('lexical benchmark preflight', () => {
  it.each(['empty', 'indexes', 'results.json'])(
    'rejects existing %s output before touching corpora',
    (contents) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexical-preflight-'));
      scratch.push(root);
      const output = path.join(root, 'output');
      fs.mkdirSync(output);
      if (contents === 'indexes') fs.mkdirSync(path.join(output, 'indexes'));
      if (contents === 'results.json')
        fs.writeFileSync(path.join(output, 'results.json'), 'prior result');
      const before = path.join(root, 'before');
      const after = path.join(root, 'after');
      const result = spawnSync(process.execPath, [harness, root, root, before, after, output], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITNEXUS_LEXICAL_BENCH_WORKER: '0',
          GITNEXUS_LEXICAL_BENCH_WORKERS: '2',
          GITNEXUS_LEXICAL_BENCH_HEAP_MIB: '4096',
        },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Output already exists');
      expect(fs.existsSync(before)).toBe(false);
      expect(fs.existsSync(after)).toBe(false);
      expect(fs.readdirSync(output)).toEqual(contents === 'empty' ? [] : [contents]);
      if (contents === 'results.json')
        expect(fs.readFileSync(path.join(output, contents), 'utf8')).toBe('prior result');
    },
  );
});
