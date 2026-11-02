import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './resolvers/helpers.js';
describe('nullable field receiver ownership', () => {
  let root: string;
  let result: PipelineResult;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-csharp-nullable-'));
    writeFixtureRepo(root, {
      'Foreign.cs': `namespace ForeignCaller {
 class User { public void Save() {} }
 class Decoy { public void Save() {} }
 class Host { External.User? repo; void ForeignCall(){this.repo.Save();} }
 }`,
      'Generic.cs': `namespace Custom { class List<T> {} }
 namespace GenericCaller {
 class User { public void Save() {} }
 class Decoy { public void Save() {} }
 class Host { Custom.List<User>? repo; void GenericCall(){this.repo.Save();} }
 }`,
      'Local.cs': `namespace LocalCaller {
 class User { public void Save() {} }
 class Host { User? repo; void LocalCall(){this.repo.Save();} }
 }`,
    });
    result = await runPipelineFromRepo(root, () => {}, {});
  }, 120000);
  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });
  const saves = (source: string) =>
    getRelationships(result, 'CALLS')
      .filter((e) => e.source === source && e.target === 'Save')
      .map((e) => e.targetFilePath);
  it('keeps a failed qualified nullable type unresolved', () => {
    expect(saves('ForeignCall')).toEqual([]);
  });
  it('does not unwrap a nullable custom generic wrapper to its argument', () => {
    expect(saves('GenericCall')).toEqual([]);
  });
  it('still binds the local nullable class field', () => {
    expect(saves('LocalCall')).toEqual(['Local.cs']);
  });
});
