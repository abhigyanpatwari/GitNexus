/**
 * Dart: field-type resolution and call-result binding.
 * Verifies that class fields are captured as Property nodes with HAS_PROPERTY
 * edges, and that calls (including chained and call-result-bound) are resolved.
 *
 * All Dart pipeline features are covered: Property nodes, HAS_PROPERTY edges,
 * CALLS chain resolution, IMPORTS, call attribution, and ACCESSES field reads.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  edgeSet,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

const dartAvailable = isLanguageAvailable(SupportedLanguages.Dart);

// ── Phase 8: Field-type resolution ──────────────────────────────────────

describe.skipIf(!dartAvailable)('Dart field-type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'dart-field-types'), () => {});
  }, 60000);

  it('detects classes and their properties', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(expect.arrayContaining(['Address', 'User']));
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('address');
    expect(properties).toContain('city');
    expect(properties).toContain('name');
  });

  it('emits HAS_PROPERTY edges from class to field', () => {
    const propEdges = getRelationships(result, 'HAS_PROPERTY');
    expect(edgeSet(propEdges)).toEqual(
      expect.arrayContaining(['User → address', 'User → name', 'Address → city']),
    );
  });

  it('resolves save() call from field-chain user.address.save()', () => {
    const calls = getRelationships(result, 'CALLS');
    // Dart attributes calls to the enclosing Function
    const saveCalls = calls.filter(
      (c) => c.target === 'save' && c.sourceFilePath.includes('app.dart'),
    );
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0]!.targetFilePath).toContain('models.dart');
  });

  it('attributes save() call source to processUser, not File', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(
      (c) => c.target === 'save' && c.sourceFilePath.includes('app.dart'),
    );
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0]!.source).toBe('processUser');
    expect(saveCalls[0]!.sourceLabel).toBe('Function');
  });

  it('creates IMPORTS edge between app.dart and models.dart', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const appImports = imports.filter(
      (e) => e.sourceFilePath.includes('app.dart') && e.targetFilePath.includes('models.dart'),
    );
    expect(appImports.length).toBe(1);
  });

  it('emits ACCESSES edges for field reads in chains', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const addressReads = accesses.filter((e) => e.target === 'address' && e.rel.reason === 'read');
    expect(addressReads.length).toBe(1);
    expect(addressReads[0]!.source).toBe('processUser');
    expect(addressReads[0]!.targetLabel).toBe('Property');
  });
});

// ── Phase 9: Call-result binding ────────────────────────────────────────

describe.skipIf(!dartAvailable)('Dart call-result binding', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'dart-call-result-binding'), () => {});
  }, 60000);

  it('detects classes, methods, and functions', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Function')).toEqual(
      expect.arrayContaining(['getUser', 'processUser']),
    );
  });

  it('resolves save() call via call-result binding', () => {
    const calls = getRelationships(result, 'CALLS');
    // Dart attributes calls to the enclosing Function
    const saveCalls = calls.filter(
      (c) => c.target === 'save' && c.sourceFilePath.includes('app.dart'),
    );
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0]!.targetFilePath).toContain('models.dart');
  });

  it('resolves getUser() call', () => {
    const calls = getRelationships(result, 'CALLS');
    const getUserCalls = calls.filter(
      (c) => c.target === 'getUser' && c.sourceFilePath.includes('app.dart'),
    );
    expect(getUserCalls.length).toBe(1);
  });

  it('attributes calls to processUser, not File', () => {
    const calls = getRelationships(result, 'CALLS');
    const appCalls = calls.filter((c) => c.sourceFilePath.includes('app.dart'));
    for (const call of appCalls) {
      expect(call.source).toBe('processUser');
      expect(call.sourceLabel).toBe('Function');
    }
  });
});
