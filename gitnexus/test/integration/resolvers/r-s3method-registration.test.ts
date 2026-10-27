/**
 * R: `S3method()` registers a method for S3 dispatch; it does not export the function.
 *
 * `pk::format_impl` errors in R ("not an exported object") when NAMESPACE only says
 * `S3method(format, pkthing, format_impl)`, and `library(pk)` does not attach it. Resolution
 * therefore treats an S3-registered-only name as private: `library()`, `pkg::name` and the
 * unique-name guess do not reach it from outside the package tree, and `pkg:::name` still does.
 * The graph node stays public (`isExported: true`): the method is public API reached through
 * dispatch, so entry-point scoring and process detection do not move, and `rename` keeps
 * refusing it.
 *
 * Fixture `r-s3method-registration/`: `pk/NAMESPACE` has `export(pub)`,
 * `S3method(format, pkthing, format_impl)` and `S3method(print, pkthing)`; `scripts/s.R`
 * attaches pk and calls each shape.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getResolutionOutcomes,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

const ROOT = path.join(FIXTURES, 'r-s3method-registration');

/** Every CALLS edge of the repository, by source node id: `targetId:reason:confidence`. */
const EXPECTED: Readonly<Record<string, readonly string[]>> = {
  // library(pk) does not attach a registered method, and the guess is refused from outside pk.
  'Function:scripts/s.R:w1': [],
  // `::` needs an export.
  'Function:scripts/s.R:w2': [],
  'Function:scripts/s.R:w3': [],
  // The dotted name's qualified lookup is refused for the same reason.
  'Function:scripts/s.R:w4': [],
  // `:::` reaches any definition.
  'Function:scripts/s.R:w5': ['Function:pk/R/a.R:format_impl:import-resolved:0.85'],
  // Control: a private dotted name.
  'Function:scripts/s.R:w6': [],
  // Inside the package nothing changes.
  'Function:pk/R/a.R:format_impl': ['Function:pk/R/a.R:render_line:local-call:0.85'],
  'Function:pk/R/a.R:print.pkthing': ['Function:pk/R/a.R:render_line:local-call:0.85'],
  'Function:pk/R/a.R:render_line': ['Function:pk/R/a.R:pad_text:local-call:0.85'],
};

/** `isExported` of every function node of the package, as the NAMESPACE refinement leaves it. */
const EXPORTED: Readonly<Record<string, boolean>> = {
  'Function:pk/R/a.R:pub': true,
  'Function:pk/R/a.R:format_impl': true,
  'Function:pk/R/a.R:print.pkthing': true,
  'Function:pk/R/a.R:hidden.fn': false,
  'Function:pk/R/a.R:render_line': false,
  'Function:pk/R/a.R:pad_text': false,
};

const callsOf = (result: PipelineResult, sourceId: string): string[] =>
  getRelationships(result, 'CALLS')
    .filter((e) => e.rel.sourceId === sourceId)
    .map((e) => `${e.rel.targetId}:${e.rel.reason}:${e.rel.confidence}`)
    .sort();

describe('R S3method() registrations are not exports', () => {
  let result: PipelineResult;
  beforeAll(async () => {
    result = await runPipelineFromRepo(ROOT, () => {});
  }, 120000);

  it.each(Object.entries(EXPECTED))('%s', (sourceId, expected) => {
    expect(callsOf(result, sourceId)).toEqual([...expected].sort());
  });

  it('the table lists every CALLS edge of the repository', () => {
    const sources = [...new Set(getRelationships(result, 'CALLS').map((e) => e.rel.sourceId))];
    const withEdges = Object.entries(EXPECTED)
      .filter(([, targets]) => targets.length > 0)
      .map(([sourceId]) => sourceId);
    expect(sources.sort()).toEqual(withEdges.sort());
  });

  it('records the refused guesses (the qualified sites are dropped before outcomes exist)', () => {
    const refused = getResolutionOutcomes(result)
      .filter((o) => o.kind === 'fallback-refused')
      .map((o) => `${o.filePath}:${o.range.startLine}:${o.name}`);
    expect(refused.sort()).toEqual(
      [
        'scripts/s.R:2:format_impl',
        'scripts/s.R:5:print.pkthing',
        'scripts/s.R:7:hidden.fn',
      ].sort(),
    );
  });

  it('keeps an S3-registered-only method public on its graph node', () => {
    const exported = Object.fromEntries(
      [...result.graph.iterNodes()]
        .filter((n) => n.label === 'Function' && n.properties.filePath === 'pk/R/a.R')
        .map((n) => [n.id, n.properties.isExported]),
    );
    expect(exported).toEqual(EXPORTED);
  });
});

describe('R S3method() registrations: entry points and processes of the package', () => {
  let result: PipelineResult;
  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(ROOT, 'pk'), () => {});
  }, 120000);

  // Measured before registrations stopped counting as exports for resolution: unchanged.
  it('detects the same processes, entered at the two registered methods', () => {
    const processes = (result.processResult?.processes ?? [])
      .map((p) => `${p.entryPointId} -> ${p.terminalId} ${p.stepCount} ${p.processType}`)
      .sort();
    expect(processes).toEqual([
      'Function:R/a.R:format_impl -> Function:R/a.R:pad_text 3 intra_community',
      'Function:R/a.R:print.pkthing -> Function:R/a.R:pad_text 3 intra_community',
    ]);
  });

  it('keeps the registered methods public when the package is the repository root', () => {
    const exported = [...result.graph.iterNodes()]
      .filter((n) => n.label === 'Function' && n.properties.isExported === true)
      .map((n) => n.id)
      .sort();
    expect(exported).toEqual([
      'Function:R/a.R:format_impl',
      'Function:R/a.R:print.pkthing',
      'Function:R/a.R:pub',
    ]);
  });
});
