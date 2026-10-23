import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './resolvers/helpers.js';

describe('nullable generic field receiver ownership', () => {
  let root: string | undefined;
  let result: PipelineResult;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-csharp-generic-field-'));
    writeFixtureRepo(root, {
      'Wrapper.cs': 'class List<T> { public void Save() {} }',
      'Outer.cs': 'class Outer<T> { public void Save() {} }',
      'Inner.cs': 'class Inner<T> { public void Save() {} }',
      'User.cs': `class User { public void Save() {} }
        namespace Models { class User { public void Save() {} } }`,
      'Host.cs': `class Host {
        List<User>? plain;
        List<Models.User>? dotted;
        Custom.List<User>? qualified;
        Outer<User>.Inner<Models.User>? nestedOuter;
        List</* > */Models.User>? commented;
        List<// >
          Models.User>? lineCommented;
        Outer</* < */User>.Inner<User>? commentedOuter;
        Outer<User>/* < */.Inner<User>? commentedSuffix;
        void PlainCall() { this.plain.Save(); }
        void DottedCall() { this.dotted.Save(); }
        void QualifiedCall() { this.qualified.Save(); }
        void NestedOuterCall() { this.nestedOuter.Save(); }
        void CommentedCall() { this.commented.Save(); }
        void LineCommentedCall() { this.lineCommented.Save(); }
        void CommentedOuterCall() { this.commentedOuter.Save(); }
        void CommentedSuffixCall() { this.commentedSuffix.Save(); }
      }`,
    });
    result = await runPipelineFromRepo(root, () => {}, {});
  }, 240000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  const saves = (source: string) =>
    getRelationships(result, 'CALLS')
      .filter((edge) => edge.source === source && edge.target === 'Save')
      .map((edge) => edge.targetFilePath);

  it('keeps an unqualified wrapper as the receiver', () => {
    expect(saves('PlainCall')).toEqual(['Wrapper.cs']);
  });

  it('keeps qualification inside the argument without selecting User.Save', () => {
    expect(saves('DottedCall')).toEqual(['Wrapper.cs']);
  });

  it('still declines a qualified outer wrapper', () => {
    expect(saves('QualifiedCall')).toEqual([]);
  });

  it('still declines qualification after a generic outer type', () => {
    expect(saves('NestedOuterCall')).toEqual([]);
  });

  it('ignores a block comment when classifying an argument-qualified wrapper', () => {
    expect(saves('CommentedCall')).toEqual(['Wrapper.cs']);
  });

  it('ignores a line comment when classifying an argument-qualified wrapper', () => {
    expect(saves('LineCommentedCall')).toEqual(['Wrapper.cs']);
  });

  it('does not borrow standalone Outer or Inner through an argument comment', () => {
    expect(saves('CommentedOuterCall')).toEqual([]);
  });

  it('does not borrow standalone Outer or Inner through a suffix comment', () => {
    expect(saves('CommentedSuffixCall')).toEqual([]);
  });
});
