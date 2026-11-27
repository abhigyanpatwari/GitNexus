import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

// #2707: extensionless scripts with a shebang are parsed, and their calls into
// ordinary modules resolve, so impact on the callee reaches the script.
describe('extensionless shebang scripts', () => {
  let repoRoot = '';
  let result: PipelineResult;

  beforeAll(async () => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-shebang-'));
    fs.mkdirSync(path.join(repoRoot, 'lib'));
    fs.mkdirSync(path.join(repoRoot, 'scripts'));
    fs.writeFileSync(
      path.join(repoRoot, 'lib', 'helpers.py'),
      'def normalize(name):\n    return name.strip().lower()\n',
    );
    fs.writeFileSync(
      path.join(repoRoot, 'scripts', 'deploy'),
      '#!/usr/bin/env python3\nfrom lib.helpers import normalize\n\n' +
        'def deploy_service(name):\n    return normalize(name)\n',
    );
    fs.writeFileSync(
      path.join(repoRoot, 'scripts', 'release'),
      '#!/usr/bin/env node\nfunction releaseAll() {\n  return 1;\n}\nreleaseAll();\n',
    );
    fs.writeFileSync(path.join(repoRoot, 'scripts', 'setup'), '#!/bin/bash\necho setup\n');
    result = await runPipelineFromRepo(repoRoot, () => undefined, { workerPoolSize: 1 });
  }, 60000);

  afterAll(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  const functionsIn = (filePath: string) =>
    result.graph.nodes
      .filter((n) => n.label === 'Function' && n.properties.filePath === filePath)
      .map((n) => n.properties.name);

  it('extracts symbols from scripts whose shebang names a supported interpreter', () => {
    expect(functionsIn('scripts/deploy')).toEqual(['deploy_service']);
    expect(functionsIn('scripts/release')).toEqual(['releaseAll']);
    expect(functionsIn('scripts/setup')).toEqual([]);
  });

  it('resolves calls from a shebang script into a regular module', () => {
    const caller = result.graph.nodes.find(
      (n) => n.properties.filePath === 'scripts/deploy' && n.properties.name === 'deploy_service',
    );
    const callee = result.graph.nodes.find(
      (n) => n.properties.filePath === 'lib/helpers.py' && n.properties.name === 'normalize',
    );
    if (!caller || !callee) throw new Error('missing deploy_service or normalize node');
    expect(
      result.graph.relationships.some(
        (r) => r.type === 'CALLS' && r.sourceId === caller.id && r.targetId === callee.id,
      ),
    ).toBe(true);
  });
});
