/**
 * Coverage for `interpretCsharpTypeBinding` type normalization, focused on the
 * F41 analog (#1928): the qualifier strip must not reach into generic type
 * ARGUMENTS. `Dictionary<string, Ns.User>` was corrupted into `User>` by an
 * unguarded `lastIndexOf('.')`. Multi-arg generics must stay intact so the
 * collection-accessor (`.Values`/`.Keys`) unwrap keeps working.
 */
import { describe, it, expect } from 'vitest';
import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { interpretCsharpTypeBinding } from '../../../../src/core/ingestion/languages/csharp/interpret.js';

const ZERO = { startLine: 0, startCol: 0, endLine: 0, endCol: 0 } as const;
const cap = (name: string, text: string): Capture => ({ name, text, range: ZERO });

function raw(typeText: string): string | undefined {
  const m: CaptureMatch = {
    '@type-binding.name': cap('@type-binding.name', 'x'),
    '@type-binding.type': cap('@type-binding.type', typeText),
    '@type-binding.annotation': cap('@type-binding.annotation', typeText),
  };
  return interpretCsharpTypeBinding(m)?.rawTypeName;
}

describe('interpretCsharpTypeBinding — type normalization (F41 analog #1928)', () => {
  it('does not corrupt a qualified generic TYPE ARGUMENT (the bug)', () => {
    // Was `User>` before the fix.
    expect(raw('Dictionary<string, Ns.User>')).toBe('Dictionary<string, Ns.User>');
  });

  it('leaves an unqualified multi-arg generic intact (collection-accessor unwrap)', () => {
    expect(raw('Dictionary<string, Widget>')).toBe('Dictionary<string, Widget>');
  });

  it('strips the OUTER qualifier of a generic while keeping the type args', () => {
    expect(raw('Ns.Dictionary<string, User>')).toBe('Dictionary<string, User>');
  });

  it('unwraps a single-arg known container to its (qualified) element type', () => {
    expect(raw('List<Ns.User>')).toBe('User');
    expect(raw('List<User>')).toBe('User');
    expect(raw('Task<User>')).toBe('User');
  });

  it('strips a plain qualifier', () => {
    expect(raw('Ns.User')).toBe('User');
    expect(raw('A.B.User')).toBe('User');
  });

  it('strips a nullable suffix', () => {
    expect(raw('User?')).toBe('User');
  });

  it('unwraps a nullable single-arg generic (`List<User>?` → `User`)', () => {
    expect(raw('List<User>?')).toBe('User');
  });

  it('does not corrupt a nested generic — keeps it intact (no `>>` artifact)', () => {
    expect(raw('List<Dictionary<string, User>>')).toBe('List<Dictionary<string, User>>');
  });

  it('strips the outer qualifier of an unrecognized generic, keeping its args', () => {
    // Accepted limitation: unknown generics are not erased to the bare base —
    // only the OUTER qualifier is removed; the generic suffix is preserved.
    expect(raw('Ns.Box<User>')).toBe('Box<User>');
  });

  it('passes through a plain simple type', () => {
    expect(raw('User')).toBe('User');
  });

  it('preserves a collection-accessor suffix (`data.Values`)', () => {
    expect(raw('data.Values')).toBe('data.Values');
  });

  it('strips nested types through a generic outer (`Ns.Outer<int>.Inner` → `Inner`)', () => {
    // Prior generic-aware strip sliced at the first `<` and regressed to
    // `Outer<int>.Inner` (unresolvable). Last `.` at bracket depth 0 fixes both
    // this shape and the F41 `Dictionary<string, Ns.User>` case (#2046 P3).
    expect(raw('Ns.Outer<int>.Inner')).toBe('Inner');
    expect(raw('Outer.Inner')).toBe('Inner');
  });
});
