import { describe, it, before as beforeAll, after as afterAll } from 'node:test';
import { expect } from 'expect';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import {
  getRelationships,
  getNodesByLabel,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from '../support/fixture.js';

// ---------------------------------------------------------------------------
// Issue #1066. The parse worker must capture calls after large ASCII and UTF-8 prefixes.
// ---------------------------------------------------------------------------

describe('TypeScript worker parsing of large files', () => {
  let repoDir: string;
  let result: PipelineResult;

  beforeAll(
    async () => {
      repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ts-large-cache-'));
      writeFixtureRepo(repoDir, {
        'src/models.ts': `
export class User {
  save(): boolean {
    return true;
  }
}
`,
        'src/ascii-app.ts': `import { User } from './models';

// ${'x'.repeat(120 * 1024)}
export function createAsciiUser(): void {
  const user = new User();
  user.save();
}
`,
        'src/utf8-app.ts': `import { User } from './models';

// ${'漢'.repeat(120_000)}
export function createUtf8User(): void {
  const user = new User();
  user.save();
}
`,
      });
      result = await runPipelineFromRepo(repoDir, () => {}, {});
    },
    { timeout: 120000 },
  );

  afterAll(() => {
    if (repoDir !== undefined) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('extracts trailing functions after large ASCII and UTF-8 padding', () => {
    expect(getNodesByLabel(result, 'Function')).toEqual(
      expect.arrayContaining(['createAsciiUser', 'createUtf8User']),
    );
  });

  it('resolves constructor calls from both padded files to User', () => {
    const calls = getRelationships(result, 'CALLS');
    for (const source of ['createAsciiUser', 'createUtf8User']) {
      const ctor = calls.find(
        (c) => c.source === source && c.target === 'User' && c.targetLabel === 'Class',
      );
      expect(ctor).toBeDefined();
      expect(ctor!.targetFilePath).toBe('src/models.ts');
    }
  });

  it('resolves member calls from both padded files to User.save', () => {
    const calls = getRelationships(result, 'CALLS');
    for (const source of ['createAsciiUser', 'createUtf8User']) {
      const save = calls.find((c) => c.source === source && c.target === 'save');
      expect(save).toBeDefined();
      expect(save!.targetFilePath).toBe('src/models.ts');
    }
  });
});
