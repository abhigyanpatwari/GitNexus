import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { emitCScopeCaptures } from '../../src/core/ingestion/languages/c/captures.js';
import { emitObjectiveCScopeCaptures } from '../../src/core/ingestion/languages/objective-c/captures.js';

const SOURCE = `#include "dep.h"
typedef struct User { int age; } User;
static int helper(int x) { return x; }
int run(User *u) { return helper(u->age); }
`;

function captureDigest(captures: ReturnType<typeof emitCScopeCaptures>): string {
  const semanticShape = captures.map((match) =>
    Object.fromEntries(Object.entries(match).map(([name, capture]) => [name, capture.text])),
  );
  return createHash('sha256').update(JSON.stringify(semanticShape)).digest('hex');
}

describe('C-family capture characterization', () => {
  it('keeps C declarations, references, imports, arity, and callable-flow byte-equivalent', () => {
    expect(captureDigest(emitCScopeCaptures(SOURCE, 'fixture.c'))).toBe(
      '2ee930d2f5e504e6803447a1d0370e9248405433ec30bca4231b76b85d275419',
    );
  });

  it('produces the same C-family semantic captures through the Objective-C grammar', () => {
    expect(captureDigest(emitObjectiveCScopeCaptures(SOURCE, 'fixture.m'))).toBe(
      captureDigest(emitCScopeCaptures(SOURCE, 'fixture.c')),
    );
  });
});
