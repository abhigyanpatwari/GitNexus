import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SupportedLanguages } from 'gitnexus-shared';
import { classifyContentLanguages } from '../../src/core/ingestion/content-language-classification.js';
import {
  getLanguageForFileContent,
  needsContentLanguageClassification,
} from '../../src/core/ingestion/languages/index.js';
import { isExtensionlessPath, shebangInterpreter } from '../../src/core/ingestion/utils/shebang.js';

describe('shebangInterpreter', () => {
  it.each([
    ['#!/usr/bin/python3\n', 'python3'],
    ['#!/usr/bin/env python3\n', 'python3'],
    ['#! /usr/bin/env python3\n', 'python3'],
    ['#!/usr/bin/env -S python3 -u\n', 'python3'],
    ['#!/usr/bin/env PYTHONUTF8=1 python3\n', 'python3'],
    ['#!/usr/bin/env -u HOME ruby\n', 'ruby'],
    ['#!/usr/bin/env -C /tmp python3\n', 'python3'],
    ['#!/usr/bin/env -S "python3 -u"\n', 'python3'],
    ["#!/usr/bin/env -S 'python3 -u'\n", 'python3'],
    ['#!/usr/bin/env --chdir /tmp python3\n', 'python3'],
    ['#!/usr/bin/env --chdir=/tmp python3\n', 'python3'],
    ['#!/usr/bin/env node\r\nconsole.log(1)\r\n', 'node'],
    ['#!/bin/bash\n', 'bash'],
    ['#!/usr/bin/env -S npx tsx\n', 'tsx'],
    ['#!/usr/bin/env -S npx --yes ts-node\n', 'ts-node'],
    ['#!/usr/bin/env -S npx -p tsx node\n', 'node'],
    ['#!/usr/bin/env -S npx --package=tsx node\n', 'node'],
    ['#!/usr/bin/env -S bunx tsx\n', 'tsx'],
    ['#!/usr/bin/env -S FOO="a b" python3\n', 'python3'],
    ["#!/usr/bin/env -S FOO='a b' BAR=1 node\n", 'node'],
  ])('reads %j as %s', (source, expected) => {
    expect(shebangInterpreter(source)).toBe(expected);
  });

  it.each([[''], ['#!\n'], ['#!/usr/bin/env\n'], ['# comment\n#!/usr/bin/env python3\n']])(
    'finds no interpreter in %j',
    (source) => {
      expect(shebangInterpreter(source)).toBeUndefined();
    },
  );
});

describe('isExtensionlessPath', () => {
  it('matches only names without an extension', () => {
    expect(isExtensionlessPath('scripts/deploy')).toBe(true);
    expect(isExtensionlessPath('a.b/deploy')).toBe(true);
    expect(isExtensionlessPath('scripts\\deploy')).toBe(true);
    expect(isExtensionlessPath('scripts/deploy.py')).toBe(false);
    expect(isExtensionlessPath('.envrc')).toBe(false);
    expect(isExtensionlessPath('scripts/')).toBe(false);
  });
});

describe('shebang language classification (#2707)', () => {
  let repoDir = '';
  afterEach(async () => {
    if (repoDir) await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('asks for content only for extensionless paths', () => {
    expect(needsContentLanguageClassification('scripts/deploy')).toBe(true);
    expect(needsContentLanguageClassification('scripts/deploy.py')).toBe(false);
  });

  it.each([
    ['#!/usr/bin/env python3\n', SupportedLanguages.Python],
    ['#!/usr/bin/python3.12 -u\n', SupportedLanguages.Python],
    ['#!/usr/bin/env pypy3\n', SupportedLanguages.Python],
    ['#!/usr/bin/env pypy3.10\n', SupportedLanguages.Python],
    ['#!/usr/bin/env -S "python3 -u"\n', SupportedLanguages.Python],
    ['#!/usr/local/bin/ruby -w\n', SupportedLanguages.Ruby],
    ['#!/usr/bin/env node\n', SupportedLanguages.JavaScript],
    ['#!/usr/bin/php\n<?php\n', SupportedLanguages.PHP],
    ['#!/usr/bin/env swift\n', SupportedLanguages.Swift],
    ['#!/usr/bin/env Rscript\n', SupportedLanguages.R],
    ['#!/usr/bin/env dart\n', SupportedLanguages.Dart],
    ['#!/usr/bin/env kotlin\n', SupportedLanguages.Kotlin],
    ['#!/usr/bin/env ts-node\n', SupportedLanguages.TypeScript],
    ['#!/usr/bin/env -S npx tsx\n', SupportedLanguages.TypeScript],
  ])('classifies an extensionless %j script', (source, language) => {
    expect(getLanguageForFileContent('scripts/tool', source)).toBe(language);
  });

  it.each([
    ['#!/bin/bash\n'],
    ['#!/usr/bin/env deno run\n'],
    ['#!/usr/bin/env bun\n'],
    ['#!/usr/bin/env -S npx prettier\n'],
    ['#!/usr/bin/env pythonista\n'],
    ['def main():\n    pass\n'],
  ])('leaves %j unclassified', (source) => {
    expect(getLanguageForFileContent('scripts/tool', source)).toBeNull();
  });

  it('never lets a shebang override an extension or a known filename', () => {
    expect(getLanguageForFileContent('run.js', '#!/usr/bin/env python3\n')).toBe(
      SupportedLanguages.JavaScript,
    );
    expect(getLanguageForFileContent('run.sh', '#!/usr/bin/env python3\n')).toBeNull();
    expect(getLanguageForFileContent('Rakefile', 'task :default\n')).toBe(SupportedLanguages.Ruby);
    // A known filename keeps its language even when the shebang names another one.
    for (const shebang of [
      '#!/usr/bin/env python3\n',
      '#!/usr/bin/php\n',
      '#!/usr/bin/env dart\n',
      '#!/usr/bin/env node\n',
    ]) {
      expect(getLanguageForFileContent('Rakefile', shebang)).toBe(SupportedLanguages.Ruby);
      expect(getLanguageForFileContent('scripts/Gemfile', shebang)).toBe(SupportedLanguages.Ruby);
    }
  });

  it('records decisions from disk', async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shebang-'));
    await fs.writeFile(
      path.join(repoDir, 'deploy'),
      '#!/usr/bin/env python3\ndef deploy(): pass\n',
    );
    await fs.writeFile(path.join(repoDir, 'build'), '#!/bin/bash\necho hi\n');

    const result = await classifyContentLanguages(repoDir, ['deploy', 'build']);
    expect([...result.entries()]).toEqual([
      ['deploy', SupportedLanguages.Python],
      ['build', null],
    ]);
  });
});
