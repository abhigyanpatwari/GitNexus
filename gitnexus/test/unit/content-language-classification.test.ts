import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SupportedLanguages } from 'gitnexus-shared';
import { classifyContentLanguages } from '../../src/core/ingestion/content-language-classification.js';
import { getLanguageForFileContent } from '../../src/core/ingestion/languages/index.js';

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
});
