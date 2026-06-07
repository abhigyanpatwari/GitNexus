/**
 * Unit tests for the C `static`-linkage capture side-channel (#1983).
 *
 * The worker pool is the sole parse path. C `static`-linkage is recorded in a
 * module-level `staticNames` map populated by `emitCScopeCaptures` INSIDE the
 * worker (`markStaticName`). That map is NOT serialized onto the returned
 * `ParsedFile`, so on the worker→main boundary it must travel as plain data on
 * `ParsedFile.captureSideChannel` (collect on the worker, apply on the main
 * thread). These tests pin that round-trip contract directly, mirroring the
 * C++ (`cpp/capture-side-channel.ts`) and Kotlin patterns:
 *
 *   1. Collect snapshots the per-file `staticNames` slice into a self-
 *      describing `{ kind: 'c', staticNames }` payload; returns `undefined`
 *      when the file recorded no statics (so the field ships only when needed).
 *   2. Apply re-populates the module map on a "fresh" process (modelled by a
 *      `clearStaticNames()` between collect and apply) WITHOUT any parse, so
 *      `isStaticName` reads true again.
 *   3. The `kind` discriminant guards apply against a foreign-language payload
 *      (the generic `captureSideChannel` field is shared with C++/Kotlin).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ParsedFile } from 'gitnexus-shared';
import {
  applyCStaticLinkageSideChannel,
  collectCStaticLinkageSideChannel,
} from '../../src/core/ingestion/languages/c/capture-side-channel.js';
import {
  clearStaticNames,
  isStaticName,
  markStaticName,
} from '../../src/core/ingestion/languages/c/static-linkage.js';

function makeParsed(filePath: string, captureSideChannel: unknown): ParsedFile {
  return { filePath, captureSideChannel } as unknown as ParsedFile;
}

describe('C static-linkage capture side-channel round-trip (#1983)', () => {
  beforeEach(() => {
    clearStaticNames();
  });

  it('collects a self-describing { kind: "c", staticNames } snapshot', () => {
    markStaticName('local.c', 'compute');
    markStaticName('local.c', 'helper');

    const snapshot = collectCStaticLinkageSideChannel('local.c');
    expect(snapshot).toBeDefined();
    expect(snapshot!.kind).toBe('c');
    // Order-independent: the set may serialize in any order.
    expect([...snapshot!.staticNames].sort()).toEqual(['compute', 'helper']);
  });

  it('returns undefined for a file with no static names (field ships only when needed)', () => {
    expect(collectCStaticLinkageSideChannel('public-only.c')).toBeUndefined();
  });

  it('apply re-populates the module map on a fresh process (no parse)', () => {
    markStaticName('local.c', 'compute');
    const snapshot = collectCStaticLinkageSideChannel('local.c');

    // Model the worker→main boundary: the main thread starts with an empty map
    // (the worker's marks never crossed the MessageChannel directly).
    clearStaticNames();
    expect(isStaticName('local.c', 'compute')).toBe(false);

    applyCStaticLinkageSideChannel(makeParsed('local.c', snapshot));
    expect(isStaticName('local.c', 'compute')).toBe(true);
  });

  it('apply ignores undefined / null / non-object payloads (no throw)', () => {
    expect(() => applyCStaticLinkageSideChannel(makeParsed('x.c', undefined))).not.toThrow();
    expect(() => applyCStaticLinkageSideChannel(makeParsed('x.c', null))).not.toThrow();
    expect(() => applyCStaticLinkageSideChannel(makeParsed('x.c', 42))).not.toThrow();
    expect(isStaticName('x.c', 'anything')).toBe(false);
  });

  it('apply ignores a foreign-language payload via the kind discriminant', () => {
    // A Kotlin-shaped snapshot must NOT be restored as C static names.
    const kotlinPayload = { kind: 'kotlin', companionScopes: ['scope:Logger.companion'] };
    applyCStaticLinkageSideChannel(makeParsed('App.kt', kotlinPayload));
    expect(isStaticName('App.kt', 'companion')).toBe(false);
    expect(isStaticName('App.kt', 'scope:Logger.companion')).toBe(false);
  });

  it('a JSON round-trip of the snapshot still applies cleanly (disk-store fidelity)', () => {
    markStaticName('mod.c', 'priv_a');
    markStaticName('mod.c', 'priv_b');
    const snapshot = collectCStaticLinkageSideChannel('mod.c');
    const throughJson = JSON.parse(JSON.stringify(snapshot)) as unknown;

    clearStaticNames();
    applyCStaticLinkageSideChannel(makeParsed('mod.c', throughJson));
    expect(isStaticName('mod.c', 'priv_a')).toBe(true);
    expect(isStaticName('mod.c', 'priv_b')).toBe(true);
  });
});
