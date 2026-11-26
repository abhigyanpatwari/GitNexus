import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { DIST_WORKER_URL, distWorkerExists } from '../helpers/worker-parse.js';

vi.setConfig({ testTimeout: 90_000 });

const describeIfWorkerBuilt = distWorkerExists() ? describe : describe.skip;

describeIfWorkerBuilt('PHP self-receiver lookup', () => {
  it('PHP: `$this` is exempt from the skip, like `this` and `self`', async () => {
    // Keep the property and method on the PHP receiver when a closure captures a same-named local.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-php-self-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'Box.php'),
        [
          '<?php',
          'class Box {',
          "    private $baseUrl = 'https://example.com';",
          '    public function helper() {',
          '        return 1;',
          '    }',
          '    public function read() {',
          "        $baseUrl = 'shadow';",
          '        $fn = function () {',
          '            return $this->baseUrl . $this->helper();',
          '        };',
          '        return $fn() . $baseUrl;',
          '    }',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );
      const result = await runPipelineFromRepo(dir, () => {}, {
        workerPoolSize: 1,
        workerUrlForTest: DIST_WORKER_URL,
        keepLocalValueSymbols: true,
      });
      const calls = result.graph.relationships
        .filter((rel) => rel.type === 'CALLS')
        .map((rel) => rel.targetId)
        .sort();

      // `$this->helper()` inside the closure reaches the class method, and the
      // same-named local `$baseUrl` never becomes a call target.
      expect(calls).toContain('Method:Box.php:Box.helper#0');
      expect(calls.filter((t) => t.includes('baseUrl'))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
