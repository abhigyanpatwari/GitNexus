import { describe, expect, it } from 'vitest';
import type { CaptureMatch } from 'gitnexus-shared';
import {
  normalizeRustTypeName,
  interpretRustTypeBinding,
} from '../../../../src/core/ingestion/languages/rust/interpret.js';

const RANGE = { startLine: 0, startCol: 0, endLine: 0, endCol: 0 };

/** Builds a minimal @type-binding.return CaptureMatch to exercise
 *  normalizeRustReturnType (private, only reachable through this hook). */
function returnTypeBinding(type: string): CaptureMatch {
  return {
    '@type-binding.name': { name: '@type-binding.name', range: RANGE, text: 'f' },
    '@type-binding.type': { name: '@type-binding.type', range: RANGE, text: type },
    '@type-binding.return': { name: '@type-binding.return', range: RANGE, text: '' },
  };
}

/**
 * #2604 coverage gap (GitNexus review-agent finding): stripDynBound's
 * documented Box<dyn Trait> and bound-list (dyn Trait + Send) shapes had no
 * test anywhere, even though the interpret.ts comment claims they're handled.
 * These exercise normalizeRustTypeName/normalizeRustReturnType directly —
 * stripDynBound itself is a private helper reached only through them.
 */
describe('Rust dyn-trait-object type-name normalization (#2604)', () => {
  it('strips a bare dyn Trait parameter type', () => {
    expect(normalizeRustTypeName('&dyn Behaviour')).toBe('Behaviour');
    expect(normalizeRustTypeName('dyn Behaviour')).toBe('Behaviour');
  });

  it('strips dyn through Box/Rc/Arc wrappers', () => {
    expect(normalizeRustTypeName('Box<dyn Trait>')).toBe('Trait');
    expect(normalizeRustTypeName('Rc<dyn Trait>')).toBe('Trait');
    expect(normalizeRustTypeName('Arc<dyn Trait>')).toBe('Trait');
  });

  it('drops an auto-trait/lifetime bound list after dyn', () => {
    expect(normalizeRustTypeName('dyn Trait + Send')).toBe('Trait');
    expect(normalizeRustTypeName("dyn Trait + Send + 'static")).toBe('Trait');
    expect(normalizeRustTypeName("Box<dyn Trait + 'static>")).toBe('Trait');
  });

  it("truncates a dyn trait's own generic arguments after stripping dyn", () => {
    expect(normalizeRustTypeName('dyn Iterator<Item = u32>')).toBe('Iterator');
  });

  it('strips dyn in return-type position, including through &', () => {
    expect(interpretRustTypeBinding(returnTypeBinding('&dyn Trait'))?.rawTypeName).toBe('Trait');
    expect(interpretRustTypeBinding(returnTypeBinding('dyn Trait + Send'))?.rawTypeName).toBe(
      'Trait',
    );
  });

  it('leaves ordinary (non-dyn) type names untouched', () => {
    expect(normalizeRustTypeName('Behaviour')).toBe('Behaviour');
    expect(normalizeRustTypeName('&Behaviour')).toBe('Behaviour');
    expect(normalizeRustTypeName('Box<Behaviour>')).toBe('Behaviour');
  });
});
