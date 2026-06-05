/**
 * Issue #20 + #26: Go IMPLEMENTS detection and COMPOSITION edge for
 * anonymous struct fields.
 *
 * Issue #20 — Go uses structural (duck) typing for interface satisfaction.
 *   A struct S implements an interface I iff S's method set is a superset
 *   of I's method set. The detector walks the per-file AST to compute both
 *   method sets and emits IMPLEMENTS edges for matches.
 *
 * Issue #26 — Anonymous struct fields (`type X struct { *Y }` / `{ Y }`)
 *   are NOT emitted as Property nodes on X. Instead, a COMPOSITION edge
 *   is emitted from X to the embedded type Y. This replaces the previous
 *   EXTENDS emission, which conflated struct embedding with class
 *   inheritance.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, getRelationships, getNodesByLabel,
  runPipelineFromRepo, type PipelineResult,
} from './resolvers/helpers.js';

// =============================================================================
// Issue #20 — Go IMPLEMENTS via method-set superset
// =============================================================================
describe('Go IMPLEMENTS via method-set analysis (issue #20)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-implements'),
      () => {},
    );
  }, 60000);

  it('detects Namer, MultiMethoder, User, Admin, Incomplete nodes (plus M2/M3 additions)', () => {
    expect(getNodesByLabel(result, 'Interface')).toEqual([
      'Closer', 'MultiMethoder', 'Namer', 'ReadCloser', 'Reader',
    ]);
    expect(getNodesByLabel(result, 'Struct')).toEqual([
      'Admin', 'Calculator', 'FileHandler', 'Incomplete', 'User',
    ]);
  });

  it('emits IMPLEMENTS User -> Namer (single-method match)', () => {
    const impls = getRelationships(result, 'IMPLEMENTS');
    const userToNamer = impls.find(e => e.source === 'User' && e.target === 'Namer');
    expect(userToNamer).toBeDefined();
    expect(userToNamer!.rel.reason).toBe('method-set');
  });

  it('emits IMPLEMENTS Admin -> MultiMethoder (multi-method match)', () => {
    const impls = getRelationships(result, 'IMPLEMENTS');
    const adminToMulti = impls.find(e => e.source === 'Admin' && e.target === 'MultiMethoder');
    expect(adminToMulti).toBeDefined();
  });

  it('does NOT emit IMPLEMENTS Incomplete -> Namer (no GetName method)', () => {
    const impls = getRelationships(result, 'IMPLEMENTS');
    const falsePositive = impls.find(e => e.source === 'Incomplete' && e.target === 'Namer');
    expect(falsePositive).toBeUndefined();
  });

  it('does NOT emit IMPLEMENTS User -> MultiMethoder (only partial match)', () => {
    const impls = getRelationships(result, 'IMPLEMENTS');
    const partial = impls.find(e => e.source === 'User' && e.target === 'MultiMethoder');
    expect(partial).toBeUndefined();
  });

  it('preserves HAS_METHOD edges on the original struct (not duplicated onto implementer)', () => {
    const userMethods = getRelationships(result, 'HAS_METHOD')
      .filter(e => e.source === 'User')
      .map(e => e.target);
    expect(userMethods).toContain('GetName');
    expect(userMethods).not.toContain('GetID');
  });

  // -------------------------------------------------------------------------
  // M2: Value-receiver method still implements the interface.
  // Go semantics: a value-receiver method is in the method set of BOTH T
  // and *T. Calculator's GetName uses a value receiver, so the IMPLEMENTS
  // edge Calculator → Namer must still be emitted.
  // -------------------------------------------------------------------------

  it('emits IMPLEMENTS Calculator -> Namer (value-receiver method, M2)', () => {
    const impls = getRelationships(result, 'IMPLEMENTS');
    const calcToNamer = impls.find(e => e.source === 'Calculator' && e.target === 'Namer');
    expect(calcToNamer).toBeDefined();
    expect(calcToNamer!.rel.reason).toBe('method-set');
  });

  it('emits HAS_METHOD for Calculator.GetName (value-receiver method, M2)', () => {
    const calcMethods = getRelationships(result, 'HAS_METHOD')
      .filter(e => e.source === 'Calculator')
      .map(e => e.target);
    expect(calcMethods).toContain('GetName');
    expect(calcMethods).toContain('Sum');
  });

  // -------------------------------------------------------------------------
  // M3: Interface embedding — ReadCloser embeds Reader and Closer.
  // FileHandler implements the leaf methods (Read, Close) and should
  // satisfy ReadCloser via promoted methods. IMPLEMENTS edges must be
  // emitted for Reader, Closer, AND ReadCloser.
  // -------------------------------------------------------------------------

  it('emits IMPLEMENTS FileHandler -> Reader (leaf method, M3)', () => {
    const impls = getRelationships(result, 'IMPLEMENTS');
    const fhToReader = impls.find(e => e.source === 'FileHandler' && e.target === 'Reader');
    expect(fhToReader).toBeDefined();
  });

  it('emits IMPLEMENTS FileHandler -> Closer (leaf method, M3)', () => {
    const impls = getRelationships(result, 'IMPLEMENTS');
    const fhToCloser = impls.find(e => e.source === 'FileHandler' && e.target === 'Closer');
    expect(fhToCloser).toBeDefined();
  });

  it('emits IMPLEMENTS FileHandler -> ReadCloser (interface embedding, M3)', () => {
    const impls = getRelationships(result, 'IMPLEMENTS');
    const fhToRC = impls.find(e => e.source === 'FileHandler' && e.target === 'ReadCloser');
    expect(fhToRC).toBeDefined();
    expect(fhToRC!.rel.reason).toBe('method-set');
  });

  it('does NOT emit IMPLEMENTS Incomplete -> ReadCloser (still incomplete, M3)', () => {
    const impls = getRelationships(result, 'IMPLEMENTS');
    const fp = impls.find(e => e.source === 'Incomplete' && e.target === 'ReadCloser');
    expect(fp).toBeUndefined();
  });
});

// =============================================================================
// Issue #26 — Go anonymous struct fields emit COMPOSITION edge
// =============================================================================
describe('Go anonymous struct fields emit COMPOSITION (issue #26)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-anonymous'),
      () => {},
    );
  }, 60000);

  it('detects Base, Derived, Log, MultiEmbed, ValEmbed structs (M4/M5 additions)', () => {
    expect(getNodesByLabel(result, 'Struct')).toEqual([
      'Base', 'Derived', 'Log', 'MultiEmbed', 'ValEmbed',
    ]);
  });

  it('emits COMPOSITION edge: Derived -> Base (anonymous *Base field)', () => {
    const compositions = getRelationships(result, 'COMPOSITION');
    const derivedToBase = compositions.find(e => e.source === 'Derived' && e.target === 'Base');
    expect(derivedToBase).toBeDefined();
    expect(derivedToBase!.rel.reason).toBe('anonymous-field');
  });

  it('emits NO EXTENDS edge (struct embedding is COMPOSITION, not EXTENDS)', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(0);
  });

  it('does NOT emit Base.Common as a Property of Derived (anonymous fields are not properties)', () => {
    // The only Property on Derived should be Name (a NAMED field).
    const derivedProps = getRelationships(result, 'HAS_PROPERTY')
      .filter(e => e.source === 'Derived')
      .map(e => e.target);
    expect(derivedProps).toContain('Name');
    expect(derivedProps).not.toContain('Common');
    expect(derivedProps).not.toContain('Base');
    expect(derivedProps).not.toContain('ID');
  });

  it('preserves Base.Common as a Method of Base, not Derived', () => {
    const derivedMethods = getRelationships(result, 'HAS_METHOD')
      .filter(e => e.source === 'Derived')
      .map(e => e.target);
    const baseMethods = getRelationships(result, 'HAS_METHOD')
      .filter(e => e.source === 'Base')
      .map(e => e.target);

    expect(derivedMethods).toContain('OwnMethod');
    expect(derivedMethods).not.toContain('Common');
    expect(baseMethods).toContain('Common');
  });

  it('preserves ID as a Property of Base, not Derived', () => {
    const baseProps = getRelationships(result, 'HAS_PROPERTY')
      .filter(e => e.source === 'Base')
      .map(e => e.target);
    expect(baseProps).toContain('ID');
  });

  // -------------------------------------------------------------------------
  // M4: Struct with TWO anonymous pointer fields must emit TWO COMPOSITION
  // edges (MultiEmbed → Base and MultiEmbed → Log).
  // -------------------------------------------------------------------------

  it('emits COMPOSITION edges for BOTH anonymous fields of MultiEmbed (M4)', () => {
    const compositions = getRelationships(result, 'COMPOSITION');
    const multiToBase = compositions.find(e => e.source === 'MultiEmbed' && e.target === 'Base');
    const multiToLog = compositions.find(e => e.source === 'MultiEmbed' && e.target === 'Log');
    expect(multiToBase).toBeDefined();
    expect(multiToBase!.rel.reason).toBe('anonymous-field');
    expect(multiToLog).toBeDefined();
    expect(multiToLog!.rel.reason).toBe('anonymous-field');
  });

  it('does NOT promote Log.Info as a Method of MultiEmbed (M4)', () => {
    const multiMethods = getRelationships(result, 'HAS_METHOD')
      .filter(e => e.source === 'MultiEmbed')
      .map(e => e.target);
    expect(multiMethods).toContain('Echo');
    expect(multiMethods).not.toContain('Info');
    expect(multiMethods).not.toContain('Common');
  });

  // -------------------------------------------------------------------------
  // M5: Value-typed (non-pointer) anonymous field also emits COMPOSITION.
  // ValEmbed embeds `Base` by value (not `*Base`). The COMPOSITION edge
  // target must be `Base` (the type name), with the reason unchanged.
  // -------------------------------------------------------------------------

  it('emits COMPOSITION edge for VALUE-typed anonymous field: ValEmbed -> Base (M5)', () => {
    const compositions = getRelationships(result, 'COMPOSITION');
    const valToBase = compositions.find(e => e.source === 'ValEmbed' && e.target === 'Base');
    expect(valToBase).toBeDefined();
    expect(valToBase!.rel.reason).toBe('anonymous-field');
  });

  it('does NOT promote Base.Common as a Method of ValEmbed (M5)', () => {
    const valMethods = getRelationships(result, 'HAS_METHOD')
      .filter(e => e.source === 'ValEmbed')
      .map(e => e.target);
    expect(valMethods).toContain('Tag');
    expect(valMethods).not.toContain('Common');
  });
});

// =============================================================================
// Issue #77 — local/anonymous struct fields must not pollute HAS_PROPERTY
// =============================================================================
describe('Go local/anonymous struct fields do NOT pollute HAS_PROPERTY (#77)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-anon-local'),
      () => {},
    );
  }, 60000);

  it('attributes only the real struct field (service) to UserHandler', () => {
    const owned = getRelationships(result, 'HAS_PROPERTY')
      .filter(e => e.source === 'UserHandler')
      .map(e => e.target)
      .sort();
    expect(owned).toEqual(['service']);
  });

  it('does not create HAS_PROPERTY edges for the local struct fields Name/Email', () => {
    const targets = getRelationships(result, 'HAS_PROPERTY').map(e => e.target);
    expect(targets).not.toContain('Name');
    expect(targets).not.toContain('Email');
  });
});
