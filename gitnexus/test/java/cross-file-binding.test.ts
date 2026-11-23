import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  getRelationships,
  getNodesByLabel,
  runPipelineFromRepo,
  type PipelineResult,
} from '../integration/resolvers/helpers.js';

const JAVA_FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'java');

describe('Phase 9 — Cross-File Call-Result Binding: Java', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(JAVA_FIXTURES, 'java-cross-file'), () => {});
  }, 60000);

  it('detects User class with save and getName methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
    expect(getNodesByLabel(result, 'Method')).toContain('getName');
  });

  it('detects getUser factory and run method', () => {
    expect(getNodesByLabel(result, 'Method')).toContain('getUser');
    expect(getNodesByLabel(result, 'Method')).toContain('run');
  });

  it('resolves user.save() in run() to User#save via cross-file return type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'run' && c.targetFilePath.includes('User'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves user.getName() in run() to User#getName via cross-file return type', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCall = calls.find(
      (c) => c.target === 'getName' && c.source === 'run' && c.targetFilePath.includes('User'),
    );
    expect(getNameCall).toBeDefined();
  });
});

describe('Consumer-Before-Provider: Java', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(JAVA_FIXTURES, 'java-consumer-before-provider'),
      () => {},
    );
  }, 60000);

  it('detects User class and save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
  });

  it('resolves user.save() in run() to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'run');
    expect(saveCall).toBeDefined();
  });
});
