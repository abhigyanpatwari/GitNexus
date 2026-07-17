import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRelationships, runPipelineFromRepo, type PipelineOptions } from './helpers.js';

async function runSource(extension: string, source: string, options: PipelineOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-callable-flow-'));
  try {
    fs.writeFileSync(path.join(root, `main.${extension}`), source, 'utf8');
    return await runPipelineFromRepo(root, () => {}, { skipGraphPhases: true, ...options });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function callsFrom(
  result: Awaited<ReturnType<typeof runSource>>,
  source: string,
): Array<{ target: string; reason: string }> {
  return getRelationships(result, 'CALLS')
    .filter((edge) => edge.source === source)
    .map((edge) => ({ target: edge.target, reason: edge.rel.reason ?? '' }));
}

describe('callable value flow', () => {
  it('resolves C function pointers, pointer copies, pointer-to-pointer loads, and two wrappers', async () => {
    const result = await runSource(
      'c',
      `
void target(void) {}
void callback(void) {}
void invoke(void (*callback)(void)) { callback(); }
void outer(void (*cb)(void)) { invoke(cb); }

int entry(void) {
  void (*fp)(void) = &target;
  void (*fp2)(void) = fp;
  void (**slot)(void) = &fp2;
  fp();
  (*fp2)();
  (*slot)();
  invoke(*slot);
  outer(target);
  return 0;
}
`,
    );

    expect(callsFrom(result, 'entry')).toEqual(
      expect.arrayContaining([
        { target: 'target', reason: 'callable-value-flow' },
        expect.objectContaining({ target: 'invoke' }),
        expect.objectContaining({ target: 'outer' }),
      ]),
    );
    expect(callsFrom(result, 'invoke')).toContainEqual({
      target: 'target',
      reason: 'callable-value-flow',
    });
    expect(callsFrom(result, 'invoke').some((edge) => edge.target === 'callback')).toBe(false);
  }, 60_000);

  it('resolves C++ function references and references to pointer variables', async () => {
    const result = await runSource(
      'cpp',
      `
void target() {}
void invoke(void (&cb)()) { cb(); }

int entry() {
  void (*fp)(void) = &target;
  void (&fr)(void) = target;
  void (*&fpr)(void) = fp;
  fr();
  fpr();
  invoke(fr);
  return 0;
}
`,
    );

    expect(callsFrom(result, 'entry')).toEqual(
      expect.arrayContaining([
        { target: 'target', reason: 'callable-value-flow' },
        expect.objectContaining({ target: 'invoke' }),
      ]),
    );
    expect(callsFrom(result, 'invoke')).toContainEqual({
      target: 'target',
      reason: 'callable-value-flow',
    });
  }, 60_000);

  it('resolves TypeScript callable assignment, copy, and actual-to-formal invocation', async () => {
    const result = await runSource(
      'ts',
      `
function target(): void {}
function invoke(callback: () => void): void { callback(); }
function outer(cb: () => void): void { invoke(cb); }

const first = target;
const second = first;
second();
outer(second);
`,
    );

    expect(callsFrom(result, 'main.ts')).toEqual(
      expect.arrayContaining([
        { target: 'target', reason: 'callable-value-flow' },
        expect.objectContaining({ target: 'outer' }),
      ]),
    );
    expect(callsFrom(result, 'invoke')).toContainEqual({
      target: 'target',
      reason: 'callable-value-flow',
    });
  }, 60_000);

  it('keeps normal/PDG targets identical and stamps calleeIds at the indirect invocation', async () => {
    const source = `
function target(): void {}
function invoke(callback: () => void): void { callback(); }
const assigned = target;
invoke(assigned);
`;
    const normal = await runSource('ts', source);
    const pdg = await runSource('ts', source, { pdg: true });
    const project = (result: Awaited<ReturnType<typeof runSource>>) =>
      callsFrom(result, 'invoke')
        .filter((edge) => edge.reason === 'callable-value-flow')
        .map((edge) => edge.target)
        .sort();
    expect(project(pdg)).toEqual(project(normal));
    expect(project(pdg)).toEqual(['target']);

    const matchingBlocks: Array<Record<string, unknown>> = [];
    pdg.graph.forEachNode((node) => {
      if (
        node.label === 'BasicBlock' &&
        typeof node.properties.text === 'string' &&
        node.properties.text.includes('callback()')
      ) {
        matchingBlocks.push(node.properties);
      }
    });
    expect(matchingBlocks).not.toHaveLength(0);
    expect(
      matchingBlocks.some(
        (properties) =>
          typeof properties.calleeIds === 'string' && properties.calleeIds.includes('target'),
      ),
    ).toBe(true);
  }, 90_000);
});
