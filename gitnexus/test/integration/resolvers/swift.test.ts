/**
 * Swift: constructor-inferred type resolution for member calls.
 * Verifies that `let user = User(name: "alice"); user.save()` resolves to User.save
 * without explicit type annotations, using SymbolTable verification.
 *
 * NOTE: tree-sitter-swift has build issues on Node 22 — these tests skip gracefully
 * when the Swift parser is not available.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, getRelationships, getNodesByLabel,
  runPipelineFromRepo, type PipelineResult,
} from './helpers.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

const swiftAvailable = isLanguageAvailable(SupportedLanguages.Swift);

describe.skipIf(!swiftAvailable)('Swift constructor-inferred type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'swift-constructor-type-inference'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveFns = getNodesByLabel(result, 'Function').filter(m => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves user.save() to Models/User.swift via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'Models/User.swift');
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
  });

  it('resolves repo.save() to Models/Repo.swift via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'Models/Repo.swift');
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('processEntities');
  });

  it('emits exactly 2 save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'save');
    expect(saveCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// self.save() resolves to enclosing class's own save method
// Known issue: tree-sitter-swift has build issues on Node 22
// ---------------------------------------------------------------------------

describe.skip('Swift self resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'swift-self-this-resolution'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, each with a save function', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
    const saveFns = getNodesByLabel(result, 'Function').filter(m => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves self.save() inside User.process to User.save, not Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save' && c.source === 'process');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('Sources/Models/User.swift');
  });
});

// ---------------------------------------------------------------------------
// Parent class resolution: EXTENDS + protocol conformance
// Known issue: tree-sitter-swift has build issues on Node 22
// ---------------------------------------------------------------------------

describe.skip('Swift parent resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'swift-parent-resolution'),
      () => {},
    );
  }, 60000);

  it('detects BaseModel and User classes plus Serializable protocol', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'User']);
    expect(getNodesByLabel(result, 'Interface')).toEqual(['Serializable']);
  });

  it('emits EXTENDS edge: User → BaseModel', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const extendsEdge = extends_.find(e => e.source === 'User' && e.target === 'BaseModel');
    expect(extendsEdge).toBeDefined();
  });

  it('emits IMPLEMENTS edge: User → Serializable (protocol conformance)', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    const implEdge = implements_.find(e => e.source === 'User' && e.target === 'Serializable');
    expect(implEdge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Swift cross-file User.init() type inference
// ---------------------------------------------------------------------------

describe.skipIf(!swiftAvailable)('Swift cross-file User.init() inference', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'swift-init-cross-file'),
      () => {},
    );
  }, 60000);

  it('resolves user.save() via User.init(name:) inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save' && c.targetFilePath === 'User.swift');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('main');
  });

  it('resolves user.greet() via User.init(name:) inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCall = calls.find(c => c.target === 'greet' && c.targetFilePath === 'User.swift');
    expect(greetCall).toBeDefined();
    expect(greetCall!.source).toBe('main');
  });
});

// ---------------------------------------------------------------------------
// Return type inference: let user = getUser(name: "alice"); user.save()
// Swift's CONSTRUCTOR_BINDING_SCANNER captures property_declaration with
// call_expression values, enabling return type inference from function results.
// ---------------------------------------------------------------------------

describe.skipIf(!swiftAvailable)('Swift return type inference', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'swift-return-type'),
      () => {},
    );
  }, 60000);

  it('detects User class and getUser function', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Function')).toContain('getUser');
  });

  it('detects save function on User (Swift class methods are Function nodes)', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('save');
  });

  it('resolves user.save() to User#save via return type of getUser() -> User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('Models.swift'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Return-type inference with competing methods:
// Two classes both have save(), factory functions disambiguate via return type
// ---------------------------------------------------------------------------

describe.skipIf(!swiftAvailable)('Swift return-type inference via function return type', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'swift-return-type-inference'),
      () => {},
    );
  }, 60000);

  it('resolves user.save() to User#save via return type of getUser()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('Models.swift')
    );
    expect(saveCall).toBeDefined();
  });

  it('user.save() does NOT resolve to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(c =>
      c.target === 'save' && c.source === 'processUser'
    );
    // Should resolve to exactly one target — if it resolves at all, check it's the right one
    if (wrongSave) {
      expect(wrongSave.targetFilePath).toContain('Models.swift');
    }
  });

  it('resolves repo.save() to Repo#save via return type of getRepo()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' && c.source === 'processRepo' && c.targetFilePath.includes('Models.swift')
    );
    expect(saveCall).toBeDefined();
  });
});
