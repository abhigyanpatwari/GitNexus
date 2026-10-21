import { describe, expect, it } from 'vitest';
import type { CaptureMatch } from 'gitnexus-shared';
import { interpretRustTypeBinding } from '../../../../src/core/ingestion/languages/rust/interpret.js';

const RANGE = { startLine: 0, startCol: 0, endLine: 0, endCol: 0 };

/** A minimal `let x = <callee>()` call-return CaptureMatch. */
function callReturnBinding(callee: string): CaptureMatch {
  return {
    '@type-binding.name': { name: '@type-binding.name', range: RANGE, text: 'x' },
    '@type-binding.type': { name: '@type-binding.type', range: RANGE, text: callee },
    '@type-binding.call-return': { name: '@type-binding.call-return', range: RANGE, text: '' },
  };
}

/**
 * A call-return binding names the TYPE for a type-qualified callee
 * (`Foo::new()`), but keeps the whole path for a module-qualified one
 * (`rp::make()`) so the provider's qualified-callee hook can find the function
 * and read its return annotation (#3498 follow-up).
 */
describe('Rust call-return binding of a qualified callee', () => {
  it.each([
    ['Foo::new', 'Foo'],
    ['Self::new', 'Self'],
    ['Vec::<u8>::new', 'Vec'],
    ['make', 'make'],
  ])('reads %s as %s', (callee, expected) => {
    expect(interpretRustTypeBinding(callReturnBinding(callee))?.rawTypeName).toBe(expected);
  });

  it.each(['rp::make', 'crate::modx::make', 'self::make', 'super::modx::make', 'a::b::make'])(
    'keeps the module path %s',
    (callee) => {
      expect(interpretRustTypeBinding(callReturnBinding(callee))?.rawTypeName).toBe(callee);
    },
  );
});
