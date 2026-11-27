import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../src/types/pipeline.js';
import { getRelationships, writeFixtureRepo } from '../helpers/resolution-graph.js';

// #2707: a shebang script must produce the same facts as its twin with an extension.
const SCRIPTS = [
  {
    name: 'py',
    shebang: '#!/usr/bin/env python3',
    ext: '.py',
    body: 'def py_main():\n    return py_helper()\n\n\ndef py_helper():\n    return 1\n',
  },
  {
    name: 'node',
    shebang: '#!/usr/bin/env node',
    ext: '.js',
    body: 'function nodeMain() { return nodeHelper(); }\nfunction nodeHelper() { return 1; }\n',
  },
  {
    name: 'tsx',
    shebang: '#!/usr/bin/env -S npx tsx',
    ext: '.ts',
    body: 'function tsMain(): number { return tsHelper(); }\nfunction tsHelper(): number { return 1; }\n',
  },
  {
    name: 'swift',
    shebang: '#!/usr/bin/env swift',
    ext: '.swift',
    body: 'func swiftMain() -> Int { return swiftHelper() }\nfunc swiftHelper() -> Int { return 1 }\n',
  },
  {
    name: 'kotlin',
    shebang: '#!/usr/bin/env kotlin',
    ext: '.kts',
    body: 'fun ktMain(): Int = ktHelper()\nfun ktHelper(): Int = 1\n',
  },
  {
    name: 'dart',
    shebang: '#!/usr/bin/env dart',
    ext: '.dart',
    body: 'int dartMain() => dartHelper();\nint dartHelper() => 1;\n',
  },
  {
    name: 'r',
    shebang: '#!/usr/bin/env Rscript',
    ext: '.R',
    body: 'r_main <- function() r_helper()\nr_helper <- function() 1\n',
  },
];

describe('extensionless shebang scripts (#2707)', () => {
  let repoRoot: string;
  let result: PipelineResult;

  beforeAll(async () => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-shebang-'));
    const files: Record<string, string> = {
      'scripts/compile': '#!/bin/bash\ncompile() { echo hi; }\n',
      'scripts/notes': 'def not_code():\n    return 1\n',
    };
    for (const s of SCRIPTS) {
      files[`scripts/${s.name}`] = `${s.shebang}\n${s.body}`;
      files[`scripts/${s.name}_twin${s.ext}`] = s.body;
    }
    writeFixtureRepo(repoRoot, files);
    result = await runPipelineFromRepo(repoRoot, () => undefined, { workerPoolSize: 1 });
  }, 180_000);

  afterAll(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  const symbolsIn = (filePath: string): string[] =>
    result.graph.nodes
      .filter(
        (node) =>
          (node.label === 'Function' || node.label === 'Method') &&
          node.properties.filePath === filePath,
      )
      .map((node) => String(node.properties.name))
      .sort();

  const callsIn = (filePath: string): string[] =>
    getRelationships(result, 'CALLS')
      .filter((edge) => edge.sourceFilePath === filePath)
      .map((edge) => `${edge.source}->${edge.target}`)
      .sort();

  it.each(SCRIPTS)('indexes the $shebang script like its $ext twin', ({ name, ext }) => {
    const script = `scripts/${name}`;
    const twin = `scripts/${name}_twin${ext}`;
    expect(symbolsIn(twin).length).toBeGreaterThan(0);
    expect(symbolsIn(script)).toEqual(symbolsIn(twin));
    expect(callsIn(script)).toEqual(callsIn(twin));
  });

  it('leaves unsupported or missing shebangs as File nodes only', () => {
    expect(symbolsIn('scripts/compile')).toEqual([]);
    expect(symbolsIn('scripts/notes')).toEqual([]);
    const files = result.graph.nodes
      .filter((node) => node.label === 'File')
      .map((node) => String(node.properties.filePath));
    expect(files).toEqual(expect.arrayContaining(['scripts/compile', 'scripts/notes']));
  });
});
