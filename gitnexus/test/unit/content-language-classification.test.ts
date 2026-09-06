import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SupportedLanguages } from 'gitnexus-shared';
import { classifyContentLanguages } from '../../src/core/ingestion/content-language-classification.js';

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
});
