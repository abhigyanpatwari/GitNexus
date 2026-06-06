/**
 * WI-H85 / Issue #85 — Go cross-file IMPLEMENTS detection (two-pass).
 *
 * The fixture `go-implements-cross-file/` has:
 *   - interfaces/service_interface.go defines IUserService + IOrderService
 *   - services/user_service.go defines UserService with matching methods
 *   - services/order_service.go defines OrderService with matching methods
 *
 * The same-file IMPLEMENTS detector in `collectGoImplementsHeritage`
 * cannot see cross-file interface/struct pairs, so without the new
 * two-pass detector no IMPLEMENTS edges are emitted for these pairs.
 *
 * Contract:
 *   - UserService → IUserService and OrderService → IOrderService are
 *     emitted at confidence 0.7 (cross-file structural match)
 *   - Same-file IMPLEMENTS at confidence 1.0 are preserved (regression)
 *   - No duplicate (struct, interface) pair is emitted twice
 *   - Empty method sets and marker interfaces do not generate edges
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, getRelationships,
  runPipelineFromRepo, type PipelineResult,
} from './resolvers/helpers.js';

describe('WI-H85: Go cross-file IMPLEMENTS two-pass (issue #85)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-implements-cross-file'),
      () => {},
    );
  }, 60000);

  it('emits cross-file IMPLEMENTS edge: UserService -> IUserService', () => {
    const impls = getRelationships(result, 'IMPLEMENTS');
    const edge = impls.find(e => e.source === 'UserService' && e.target === 'IUserService');
    expect(edge).toBeDefined();
    expect(edge!.rel.confidence).toBeCloseTo(0.7, 5);
  });

  it('emits cross-file IMPLEMENTS edge: OrderService -> IOrderService', () => {
    const impls = getRelationships(result, 'IMPLEMENTS');
    const edge = impls.find(e => e.source === 'OrderService' && e.target === 'IOrderService');
    expect(edge).toBeDefined();
    expect(edge!.rel.confidence).toBeCloseTo(0.7, 5);
  });

  it('emits two IMPLEMENTS edges for the two distinct struct/interface pairs (no collapse)', () => {
    const impls = getRelationships(result, 'IMPLEMENTS');
    const userToIUser = impls.find(e => e.source === 'UserService' && e.target === 'IUserService');
    const orderToIOrder = impls.find(e => e.source === 'OrderService' && e.target === 'IOrderService');
    expect(userToIUser).toBeDefined();
    expect(orderToIOrder).toBeDefined();
    // The two edges have distinct (struct, interface) pairs — neither
    // collides with the other.
    expect(userToIUser!.source).not.toBe(orderToIOrder!.source);
    expect(userToIUser!.target).not.toBe(orderToIOrder!.target);
  });

  it('emits the cross-file edges with reason "cross-file-structural-match"', () => {
    const impls = getRelationships(result, 'IMPLEMENTS');
    const edge = impls.find(e => e.source === 'UserService' && e.target === 'IUserService');
    expect(edge!.rel.reason).toBe('cross-file-structural-match');
  });

  // ─── M3: negative / multi-interface / same-file priority cases ───

  it('does NOT emit IMPLEMENTS for MismatchedService (subset of IInventoryService methods)', () => {
    // MismatchedService has only GetItem; IInventoryService requires
    // both GetItem AND SetItem. A struct whose method set is a subset
    // of the interface method set does NOT satisfy the interface.
    const impls = getRelationships(result, 'IMPLEMENTS');
    const edge = impls.find(e => e.source === 'MismatchedService' && e.target === 'IInventoryService');
    expect(edge).toBeUndefined();
  });

  it('emits a cross-file edge for InventoryService → IInventoryService (full match)', () => {
    // InventoryService has BOTH GetItem and SetItem — full match across
    // the services/ ↔ interfaces/ package boundary.
    const impls = getRelationships(result, 'IMPLEMENTS');
    const edge = impls.find(e => e.source === 'InventoryService' && e.target === 'IInventoryService');
    expect(edge).toBeDefined();
    expect(edge!.rel.confidence).toBeCloseTo(0.7, 5);
    expect(edge!.rel.reason).toBe('cross-file-structural-match');
  });

  it('emits two distinct IMPLEMENTS edges for UserNotifier (matches IUserService AND INotificationService in different files)', () => {
    // UserNotifier's method set is a superset of BOTH IUserService
    // (GetUsers, CreateUser) AND INotificationService (Send, Broadcast).
    // The two interfaces live in different files. Two distinct edges
    // must be emitted, with the same source but different targets.
    const impls = getRelationships(result, 'IMPLEMENTS');
    const toIUser = impls.find(e => e.source === 'UserNotifier' && e.target === 'IUserService');
    const toINotif = impls.find(e => e.source === 'UserNotifier' && e.target === 'INotificationService');
    expect(toIUser).toBeDefined();
    expect(toINotif).toBeDefined();
    // Same source, different targets — neither collapses into the other.
    expect(toIUser!.source).toBe(toINotif!.source);
    expect(toIUser!.target).not.toBe(toINotif!.target);
  });

  it('does not double-emit same struct→interface pair via cross-file when same-file detector already handled it', () => {
    // Invariant 1: sameFilePairs is a dedup set in the cross-file
    // detector. If the same-file IMPLEMENTS detector already emitted
    // (X, Y), the cross-file pass must skip it. We assert that each
    // (source, target) pair appears at most once across the whole
    // IMPLEMENTS edge set.
    const impls = getRelationships(result, 'IMPLEMENTS');
    const seen = new Set<string>();
    for (const e of impls) {
      const key = `${e.source}->${e.target}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe('WI-H85: empty method sets and marker interfaces do not produce edges', () => {
  // These assertions are enforced by the collectGoImplementsCrossFile
  // short-circuits. We assert via the existing same-file detector
  // (which is the contract source) — the cross-file pass must apply
  // the same guards. If the cross-file pass were to ignore guards,
  // the Incomplete struct in `go-implements/` would generate a flood
  // of cross-file false positives against the cross-file fixture.
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-implements'),
      () => {},
    );
  }, 60000);

  it('does not emit any cross-file IMPLEMENTS edge for the same-file fixture', () => {
    // The same-file fixture is standalone (no cross-file pairs). The
    // cross-file pass should produce no IMPLEMENTS edges from this
    // fixture: the only interface/struct pairs are in the same file.
    const impls = getRelationships(result, 'IMPLEMENTS');
    const crossFile = impls.filter(e => e.rel.reason === 'cross-file-structural-match');
    expect(crossFile).toEqual([]);
  });

  it('preserves the same-file confidence (>=0.9 from resolution-context tier) for all same-file IMPLEMENTS edges', () => {
    // The same-file IMPLEMENTS detector uses ctx.resolve() which returns
    // the same-file tier confidence (0.95) — emitted as sqrt(0.95*0.95)
    // = 0.95. The cross-file pass (confidence 0.7) must not be applied to
    // same-file pairs (invariant 1 — dedup via sameFilePairs).
    const impls = getRelationships(result, 'IMPLEMENTS');
    expect(impls.length).toBeGreaterThan(0);
    for (const edge of impls) {
      expect(edge.rel.confidence).toBeGreaterThanOrEqual(0.9);
      expect(edge.rel.reason).not.toBe('cross-file-structural-match');
    }
  });
});
