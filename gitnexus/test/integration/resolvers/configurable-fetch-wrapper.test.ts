/**
 * Integration test: configurable fetch wrappers (#1589/#1852 residual)
 *
 * The parse-phase auto-detector only flags functions that call the bare global
 * `fetch()`. A wrapper built on axios / a custom client — like `doRequest` in
 * this fixture — is invisible to it, so `route_map` silently reports
 * `consumers: []` (exactly the "named outside convention" hole #1858 calls out).
 *
 * Declaring the wrapper name in `.gitnexusrc` `fetchWrappers` (threaded here via
 * PipelineOptions) lets the routes-phase consumer scan trace it, producing the
 * FETCHES edge. The control run (no config) proves the gap; the configured run
 * proves the fix.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

const FIXTURE = path.join(FIXTURES, 'configurable-fetch-wrapper');

describe('Configurable fetch wrapper consumer extraction', () => {
  let withConfig: PipelineResult;
  let withoutConfig: PipelineResult;

  beforeAll(async () => {
    withoutConfig = await runPipelineFromRepo(FIXTURE, () => {});
    withConfig = await runPipelineFromRepo(FIXTURE, () => {}, {
      fetchWrappers: ['doRequest'],
    });
  }, 60000);

  it('does NOT trace an axios-based wrapper without configuration (the gap)', () => {
    const edges = getRelationships(withoutConfig, 'FETCHES');
    const thingsEdge = edges.find((e) => e.target === '/api/things');
    expect(thingsEdge).toBeUndefined();
  });

  it('traces the configured wrapper as a route consumer', () => {
    const edges = getRelationships(withConfig, 'FETCHES');
    const thingsEdge = edges.find(
      (e) => e.sourceFilePath.includes('ThingsList') && e.target === '/api/things',
    );
    expect(thingsEdge).toBeDefined();
  });

  it('does NOT match a configured bare name inside a longer non-ASCII identifier (#1852 review F10)', () => {
    // Accented.tsx calls `cafédoRequest('/api/things')` — `doRequest` preceded by
    // the non-ASCII letter `é`. The Unicode-aware lookbehind must reject it.
    const edges = getRelationships(withConfig, 'FETCHES');
    const spurious = edges.find(
      (e) => e.sourceFilePath.includes('Accented') && e.target === '/api/things',
    );
    expect(spurious).toBeUndefined();
  });
});
