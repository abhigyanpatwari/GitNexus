import { describe, it, before as beforeAll } from 'node:test';
import { expect } from 'expect';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  getNodesByLabelFull,
  runPipelineFromRepo,
  type PipelineResult,
} from '../support/fixture.js';

// ── Phase P: Optional / Default Parameter Arity Resolution ───────────────

describe('TypeScript optional parameter arity resolution', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-optional-params'), () => {});
    },
    { timeout: 60000 },
  );

  it('resolves greet("Alice") with 1 arg to greet with 2 params (1 optional)', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCalls = calls.filter((c) => c.source === 'process' && c.target === 'greet');
    expect(greetCalls.length).toBe(1);
  });

  it('resolves search("test") with 1 arg to search with 2 params (1 optional)', () => {
    const calls = getRelationships(result, 'CALLS');
    const searchCalls = calls.filter((c) => c.source === 'process' && c.target === 'search');
    expect(searchCalls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Method enrichment: abstract, static, parameterTypes, annotations
// ---------------------------------------------------------------------------

describe('TypeScript method enrichment', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-method-enrichment'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

  it('detects Animal and Dog classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('Animal');
    expect(classes).toContain('Dog');
  });

  it('emits HAS_METHOD edges for Animal methods', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const animalMethods = hasMethod
      .filter((e) => e.source === 'Animal')
      .map((e) => e.target)
      .sort();
    expect(animalMethods).toContain('speak');
    expect(animalMethods).toContain('classify');
    expect(animalMethods).toContain('breathe');
  });

  it('emits HAS_METHOD edge for Dog.speak', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const dogSpeak = hasMethod.find((e) => e.source === 'Dog' && e.target === 'speak');
    expect(dogSpeak).toBeDefined();
  });

  it('emits EXTENDS edge Dog -> Animal', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const dogExtends = extends_.find((e) => e.source === 'Dog' && e.target === 'Animal');
    expect(dogExtends).toBeDefined();
  });

  it('resolves dog.speak() CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const speakCall = calls.find(
      (c) => c.target === 'speak' && c.sourceFilePath.includes('app.ts'),
    );
    expect(speakCall).toBeDefined();
  });

  it('resolves Animal.classify("dog") static CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const classifyCall = calls.find(
      (c) => c.target === 'classify' && c.sourceFilePath.includes('app.ts'),
    );
    expect(classifyCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Overloaded method disambiguation: interface with overloaded find + save,
// concrete class implements all three. TypeScript overloads collapse to one
// implementation signature — expect the implementation body, not individual
// overload signatures.
// ---------------------------------------------------------------------------

describe('TypeScript overloaded method disambiguation', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-overload-dispatch'), () => {});
    },
    { timeout: 60000 },
  );

  it('TypeScript overloads collapse — find has one METHOD_IMPLEMENTS edge from implementation body', () => {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    // TS class overload signatures collapse to the implementation body's node ID.
    // Type-hash is intentionally skipped for TS because overload signatures are
    // declaration-only contracts, not true same-arity overloads like Java.
    const findEdges = mi.filter(
      (e) =>
        e.source === 'find' &&
        e.target === 'find' &&
        e.sourceFilePath.includes('sql-repository') &&
        e.targetFilePath.includes('repository'),
    );
    expect(findEdges.length).toBe(1);
  });
});

// ── Phase P: Same-arity overloads — cross-file + chain resolution ─────────

describe('TypeScript same-arity overload cross-file resolution', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-same-arity-cross-file'), () => {});
    },
    { timeout: 60000 },
  );

  it('DbLookup.find overload signatures collapse to one node (type-hash skipped for TS)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const findNodes = methods.filter(
      (m) => m.name === 'find' && m.properties.filePath?.includes('db-lookup'),
    );
    // TS overload signatures collapse to the implementation body — 1 node
    expect(findNodes.length).toBe(1);
  });

  it('ILookup.find interface declarations collapse to one node (type-hash skipped for TS)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const findNodes = methods.filter(
      (m) => m.name === 'find' && m.properties.filePath?.includes('ilookup'),
    );
    // Interface overloads also collapse — TS type-hash is skipped
    expect(findNodes.length).toBe(1);
  });

  it('emits METHOD_IMPLEMENTS from DbLookup.find → ILookup.find', () => {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const edges = mi.filter(
      (e) =>
        e.source === 'find' &&
        e.target === 'find' &&
        e.sourceFilePath.includes('db-lookup') &&
        e.targetFilePath.includes('ilookup'),
    );
    expect(edges.length).toBe(1);
  });
});
