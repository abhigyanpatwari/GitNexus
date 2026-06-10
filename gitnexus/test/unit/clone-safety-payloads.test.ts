/**
 * #2143 — the concrete worker-boundary payload types are `Cloneable`.
 *
 * The provider hooks (`extractTemplateConstraints`, `collectCaptureSideChannel`)
 * feed `unknown`-typed worker-result sinks and are wrapped in `assertCloneable`
 * at their source sites (c-cpp.ts, kotlin.ts). These type-level assertions pin
 * the guarantee INDEPENDENTLY of that wiring: if a future field added to any of
 * these payloads is non-serializable (a function, symbol, …), `Cloneable<T>`
 * resolves to a type containing `never` at that key and `[T] extends
 * [Cloneable<T>]` becomes `false`, so the `: true` annotation fails the
 * type-check (`tsconfig.test.json`) — catching the regression even if someone
 * later removes the `assertCloneable` wrapper from the provider.
 *
 * Type-only imports (erased at runtime); the single runtime assertion exists so
 * the file is a real, runnable test.
 */
import { describe, it, expect } from 'vitest';

import type { Cloneable } from '../../src/core/ingestion/workers/clone-safety.js';
import type { CppConstraintPayload } from '../../src/core/ingestion/languages/cpp/constraint-extractor.js';
import type { CppCaptureSideChannel } from '../../src/core/ingestion/languages/cpp/capture-side-channel.js';
import type { CCaptureSideChannel } from '../../src/core/ingestion/languages/c/capture-side-channel.js';
import type { KotlinCaptureSideChannel } from '../../src/core/ingestion/languages/kotlin/capture-side-channel.js';

// `[T] extends [Cloneable<T>] ? true : false` is `true` iff T is wholly
// clone-safe. Tuple-wrapped to avoid distributing over unions / `never`.
type IsCloneable<T> = [T] extends [Cloneable<T>] ? true : false;

describe('#2143: worker-boundary payload types are Cloneable', () => {
  it('CppConstraintPayload / CppCaptureSideChannel / CCaptureSideChannel / KotlinCaptureSideChannel', () => {
    const cppConstraint: IsCloneable<CppConstraintPayload> = true;
    const cppSideChannel: IsCloneable<CppCaptureSideChannel> = true;
    const cSideChannel: IsCloneable<CCaptureSideChannel> = true;
    const kotlinSideChannel: IsCloneable<KotlinCaptureSideChannel> = true;
    // Array equality (not `&&`) so this isn't a trivial-always-true conditional;
    // the real assertions are the `: IsCloneable<…> = true` annotations above.
    expect([cppConstraint, cppSideChannel, cSideChannel, kotlinSideChannel]).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });
});
