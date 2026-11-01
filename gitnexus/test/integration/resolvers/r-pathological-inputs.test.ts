/**
 * R: a file of deeply nested or very wide calls is indexed, and the run ends in bounded time.
 *
 * Replacement-call detection used to walk up from every free call, which is cubic in the
 * first-argument nesting depth and quadratic in the number of call-valued arguments. A
 * 1,500-deep `nn(...)` then stalled the parse worker until the file was dropped, and 10,000
 * `k = fn(i)` arguments aborted the whole analyse. Each file here carries a sentinel function:
 * if the file were dropped, the sentinel would be missing.
 *
 * The files are generated into a temporary directory; nothing large is committed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runPipelineFromRepo, writeFixtureRepo, type PipelineResult } from './helpers.js';

let home: string;
beforeAll(() => {
  // The pipeline is run in-process on a temporary repository; keep any GitNexus state it
  // might write away from the user's home.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-r-patho-home-'));
  vi.stubEnv('GITNEXUS_HOME', home);
  vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000');
});
afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

/** Run the pipeline over one generated file; returns the result and the elapsed time. */
async function indexOne(
  name: string,
  file: string,
  source: string,
): Promise<{ result: PipelineResult; ms: number }> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `gn-r-patho-${name}-`));
  try {
    writeFixtureRepo(repo, { [file]: source });
    const started = performance.now();
    const result = await runPipelineFromRepo(repo, () => {});
    return { result, ms: performance.now() - started };
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

/** Labels of the nodes the pipeline made for `file`, as `Label:name`. */
const nodesOf = (result: PipelineResult, file: string): string[] => {
  const out: string[] = [];
  result.graph.forEachNode((n) => {
    if (n.properties.filePath === file) out.push(`${n.label}:${n.properties.name}`);
  });
  return out.sort();
};

describe('R pathological inputs', () => {
  it('indexes a file with first-argument nesting 1,500 deep', async () => {
    const source =
      'deep <- ' +
      'nn('.repeat(1500) +
      'x' +
      ')'.repeat(1500) +
      '\n' +
      'sentinel_deep <- function() 1\n';
    const { result, ms } = await indexOne('deep', 'deep.R', source);
    const nodes = nodesOf(result, 'deep.R');
    expect(nodes).toContain('File:deep.R');
    expect(nodes).toContain('Function:sentinel_deep');
    expect(ms).toBeLessThan(60_000);
  }, 300_000);

  it('indexes a file with 10,000 call-valued arguments', async () => {
    const args = Array.from({ length: 10_000 }, (_, i) => `k${i} = fn(${i})`).join(', ');
    const source = `wide <- c(${args})\nsentinel_wide <- function() 1\n`;
    const { result, ms } = await indexOne('wide', 'wide.R', source);
    const nodes = nodesOf(result, 'wide.R');
    expect(nodes).toContain('File:wide.R');
    expect(nodes).toContain('Function:sentinel_wide');
    expect(ms).toBeLessThan(60_000);
  }, 300_000);
});
