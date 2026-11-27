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

describe('content language classification', () => {
  let repoDir = '';

  afterEach(async () => {
    if (repoDir) await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('retains only reusable language decisions and skips unreadable files', async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'content-language-classification-'));
    await fs.writeFile(
      path.join(repoDir, 'ObjectiveC.h'),
      '@interface ObjectiveC : NSObject\n@end\n',
    );
    await fs.writeFile(
      path.join(repoDir, 'CoreFoundation.h'),
      '#import <CoreFoundation/CoreFoundation.h>\nclass NativeHeader {};\n',
    );

    const classifications = await classifyContentLanguages(repoDir, [
      'ObjectiveC.h',
      'CoreFoundation.h',
      'missing.h',
    ]);

    expect([...classifications.entries()]).toEqual([
      ['ObjectiveC.h', SupportedLanguages.ObjectiveC],
      ['CoreFoundation.h', SupportedLanguages.CPlusPlus],
    ]);
    expect(classifications.has('missing.h')).toBe(false);
    expect(classifications.get('ObjectiveC.h')).not.toContain('@interface');
  });

  it('keeps TypeScript module extensions in the provider fallback map', () => {
    expect(getLanguageForFileContent('service.mts', 'export class EsmService {}')).toBe(
      SupportedLanguages.TypeScript,
    );
    expect(getLanguageForFileContent('service.cts', 'export class CjsService {}')).toBe(
      SupportedLanguages.TypeScript,
    );
  });

  it('parses Objective-C header snippets with the Objective-C language', () => {
    expect(
      getLanguageForFileContent('Worker.h', '@protocol Worker <NSObject>\n- (void)run;\n@end\n'),
    ).toBe(SupportedLanguages.ObjectiveC);
    expect(getLanguageForFileContent('Worker.h', '- (void)run;\n')).toBe(
      SupportedLanguages.ObjectiveC,
    );
    expect(getLanguageForFileContent('widget.h', 'class Widget { int value; };\n')).toBe(
      SupportedLanguages.CPlusPlus,
    );
  });

  it('keeps extensionless Ruby filenames when content classification misses', () => {
    expect(getLanguageForFileContent('Rakefile', 'task :default do\nend\n')).toBe(
      SupportedLanguages.Ruby,
    );
    expect(getLanguageForFileContent('Gemfile', 'source "https://rubygems.org"\n')).toBe(
      SupportedLanguages.Ruby,
    );
  });

  it('classifies extensionless scripts by their shebang interpreter', () => {
    const cases: Array<[string, string, SupportedLanguages | null]> = [
      ['scripts/deploy', '#!/usr/bin/env python3\nprint(1)\n', SupportedLanguages.Python],
      ['scripts/legacy', '#!/usr/bin/python2.7\n', SupportedLanguages.Python],
      ['scripts/fast', '#!/usr/bin/env -S python3 -u\n', SupportedLanguages.Python],
      ['scripts/env', '#!/usr/bin/env PYTHONPATH=. python3\n', SupportedLanguages.Python],
      ['bin/release', '#!/usr/bin/env node\nconsole.log(1);\n', SupportedLanguages.JavaScript],
      ['bin/codegen', '#!/usr/bin/env tsx\n', SupportedLanguages.TypeScript],
      ['bin/migrate', '#!/usr/bin/env ruby\n', SupportedLanguages.Ruby],
      ['bin/console', '#!/usr/bin/env php\n<?php echo 1;\n', SupportedLanguages.PHP],
      ['bin/report', '#!/usr/bin/env Rscript\n', SupportedLanguages.R],
    ];
    for (const [filePath, content, language] of cases) {
      expect(getLanguageForFileContent(filePath, content), filePath).toBe(language);
    }
  });

  it('leaves scripts alone when the shebang does not name a supported interpreter', () => {
    expect(getLanguageForFileContent('scripts/setup', '#!/bin/bash\necho hi\n')).toBeNull();
    expect(getLanguageForFileContent('scripts/run', '#!/usr/bin/env deno\n')).toBeNull();
    expect(getLanguageForFileContent('scripts/empty', '#!\n')).toBeNull();
    expect(getLanguageForFileContent('scripts/notes', 'python3 is mentioned here\n')).toBeNull();
    // Only the first line counts.
    expect(getLanguageForFileContent('scripts/doc', '\n#!/usr/bin/env python3\n')).toBeNull();
  });

  it('never lets a shebang override an extension or a filename language', () => {
    expect(getLanguageForFileContent('tool.sh', '#!/usr/bin/env python3\n')).toBeNull();
    expect(getLanguageForFileContent('tool.rb', '#!/usr/bin/env python3\n')).toBe(
      SupportedLanguages.Ruby,
    );
    expect(getLanguageForFileContent('Rakefile', '#!/usr/bin/env python3\n')).toBe(
      SupportedLanguages.Ruby,
    );
  });

  it('reads only extensionless scripts for shebang classification', () => {
    expect(needsContentLanguageClassification('scripts/deploy')).toBe(true);
    expect(needsContentLanguageClassification('scripts/deploy.py')).toBe(false);
    expect(needsContentLanguageClassification('Gemfile')).toBe(false);
  });
});
