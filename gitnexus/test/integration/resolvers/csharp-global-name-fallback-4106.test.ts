/**
 * C# global-name-fallback namespace visibility (#4106).
 *
 * When a C# file constructs a type not in its imports (e.g. `new Color(...)` from
 * `using UnityEngine;`), the free-call fallback must NOT link it to an in-repo
 * type whose namespace (`Vendor.Proto`) the caller never imports.
 *
 * A second file that DOES `using Vendor.Proto;` should still resolve correctly.
 *
 * Modeled on the Go/Ruby tests in `name-fallback-edges.test.ts`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  getRelationships,
  getResolutionOutcomes,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

const FIXTURE = path.resolve(
  __dirname,
  '..',
  '..',
  'fixtures',
  'lang-resolution',
  'csharp-global-name-fallback-namespace',
);

describe('C# global-name fallback refuses cross-namespace calls (#4106)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(FIXTURE, () => {});
  }, 120000);

  it('does NOT emit a CALLS edge from Painter.Run to Vendor.Proto.Color', () => {
    const calls = getRelationships(result, 'CALLS');
    const spurious = calls.filter(
      (c) => c.source === 'Run' && c.sourceFilePath?.includes('Painter.cs') && c.target === 'Color',
    );
    expect(spurious).toEqual([]);
  });

  it('DOES emit a CALLS edge from Painter2.Run to Vendor.Proto.Color', () => {
    const calls = getRelationships(result, 'CALLS');
    const valid = calls.filter(
      (c) =>
        c.source === 'Run' && c.sourceFilePath?.includes('Painter2.cs') && c.target === 'Color',
    );
    expect(valid.length).toBeGreaterThan(0);
  });

  it('records the Painter drop as a fallback-refused outcome', () => {
    const refusals = getResolutionOutcomes(result).filter(
      (o) => o.kind === 'fallback-refused' && o.name === 'Color',
    );
    expect(refusals.length).toBeGreaterThan(0);
  });
});
