/**
 * Regression tests for C/C++ scope-resolution coverage gaps (issue #1919).
 *
 * F5 — a computed `#include MACRO` must NOT become a literal import source.
 * The macro name is an `identifier` path node (not a header path), so emitting
 * it would create a garbage import edge. Literal `<stdio.h>` (system_lib_string)
 * and `"local.h"` (string_literal) includes must keep emitting correct sources.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { emitCScopeCaptures } from '../../../src/core/ingestion/languages/c/index.js';
import { emitCppScopeCaptures } from '../../../src/core/ingestion/languages/cpp/index.js';
import type { CaptureMatch } from 'gitnexus-shared';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(
  here,
  '..',
  '..',
  'fixtures',
  'lang-resolution',
  'c-coverage',
  'main.c',
);

function importSources(matches: readonly CaptureMatch[]): string[] {
  return matches
    .filter((m) => m['@import.source'] !== undefined)
    .map((m) => m['@import.source'].text);
}

// ---------------------------------------------------------------------------
// F5 — computed #include MACRO is not emitted as a literal import source (C)
// ---------------------------------------------------------------------------

describe('F5 — computed #include MACRO (C)', () => {
  const src = fs.readFileSync(FIXTURE, 'utf8');
  const matches = emitCScopeCaptures(src, 'main.c') as CaptureMatch[];
  const sources = importSources(matches);

  it('emits import sources for literal <stdio.h> and "local.h"', () => {
    expect(sources).toContain('stdio.h');
    expect(sources).toContain('local.h');
  });

  it('does NOT emit a garbage import source for #include HDR', () => {
    // The macro name and any expansion text must never surface as a source.
    expect(sources).not.toContain('HDR');
    expect(sources).not.toContain('computed.h');
    // Exactly the two literal includes — no spurious third source.
    expect(sources).toHaveLength(2);
  });

  it('marks the system header <stdio.h> as a system include', () => {
    const systemSources = matches
      .filter((m) => m['@import.system'] !== undefined)
      .map((m) => m['@import.source']?.text);
    expect(systemSources).toContain('stdio.h');
    expect(systemSources).not.toContain('local.h');
  });
});

// ---------------------------------------------------------------------------
// F5 — computed #include MACRO is not emitted as a literal import source (C++)
// ---------------------------------------------------------------------------

describe('F5 — computed #include MACRO (C++)', () => {
  // Inline C++ source mixing literal + computed includes — the cpp decomposer
  // path (splitCppInclude) is independently exercised here.
  const src =
    '#include <map>\n#include "User.h"\n#define HDR "computed.h"\n#include HDR\n\nint main() { return 0; }\n';
  const matches = emitCppScopeCaptures(src, 'main.cpp') as CaptureMatch[];
  const sources = importSources(matches);

  it('emits import sources for literal <map> and "User.h"', () => {
    expect(sources).toContain('map');
    expect(sources).toContain('User.h');
  });

  it('does NOT emit a garbage import source for #include HDR', () => {
    expect(sources).not.toContain('HDR');
    expect(sources).not.toContain('computed.h');
    expect(sources).toHaveLength(2);
  });
});
