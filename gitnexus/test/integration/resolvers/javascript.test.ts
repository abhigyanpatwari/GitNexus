/**
 * JavaScript: self/this resolution, parent resolution, super resolution
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, getRelationships, getNodesByLabel,
  runPipelineFromRepo, type PipelineResult,
} from './helpers.js';

// ---------------------------------------------------------------------------
// this.save() resolves to enclosing class's own save method
// ---------------------------------------------------------------------------

describe('JavaScript this resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'javascript-self-this-resolution'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves this.save() inside User.process to User.save, not Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save' && c.source === 'process');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('src/models/User.js');
  });
});

// ---------------------------------------------------------------------------
// Parent class resolution: EXTENDS edge
// ---------------------------------------------------------------------------

describe('JavaScript parent resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'javascript-parent-resolution'),
      () => {},
    );
  }, 60000);

  it('detects BaseModel and User classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'User']);
  });

  it('emits EXTENDS edge: User → BaseModel', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('User');
    expect(extends_[0].target).toBe('BaseModel');
  });

  it('EXTENDS edge points to real graph node', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const target = result.graph.getNode(extends_[0].rel.targetId);
    expect(target).toBeDefined();
    expect(target!.properties.name).toBe('BaseModel');
  });
});

// ---------------------------------------------------------------------------
// super.save() resolves to parent class's save method
// ---------------------------------------------------------------------------

describe('JavaScript super resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'javascript-super-resolution'),
      () => {},
    );
  }, 60000);

  it('detects BaseModel, User, and Repo classes, each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'Repo', 'User']);
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'save');
    expect(saveMethods.length).toBe(3);
  });

  it('emits EXTENDS edge: User → BaseModel', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('User');
    expect(extends_[0].target).toBe('BaseModel');
  });

  it('resolves super.save() inside User to BaseModel.save, not Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const superSave = calls.find(c => c.source === 'save' && c.target === 'save'
      && c.targetFilePath === 'src/models/Base.js');
    expect(superSave).toBeDefined();
    const repoSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'src/models/Repo.js');
    expect(repoSave).toBeUndefined();
  });
});
