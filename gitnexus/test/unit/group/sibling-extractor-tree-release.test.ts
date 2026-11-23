/**
 * The topic, gRPC, Thrift and include extractors parse one file after another.
 * node-tree-sitter frees a tree's native memory only in a finalizer that Node
 * runs from a `setImmediate`, so each loop must yield a macrotask every
 * `PARSES_PER_RELEASE` parses or every tree it dropped stays in memory until
 * the loop ends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const probe = vi.hoisted(() => ({ turn: 0, parseTurns: [] as number[] }));

vi.mock('../../../src/core/tree-sitter/safe-parse.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/core/tree-sitter/safe-parse.js')>();
  return {
    ...actual,
    parseSourceSafe: (...args: Parameters<typeof actual.parseSourceSafe>) => {
      probe.parseTurns.push(probe.turn);
      return actual.parseSourceSafe(...args);
    },
  };
});

import { TopicExtractor } from '../../../src/core/group/extractors/topic-extractor.js';
import { GrpcExtractor } from '../../../src/core/group/extractors/grpc-extractor.js';
import { ThriftExtractor } from '../../../src/core/group/extractors/thrift-extractor.js';
import { IncludeExtractor } from '../../../src/core/group/extractors/include-extractor.js';
import type { ContractExtractor } from '../../../src/core/group/contract-extractor.js';
import type { RepoHandle } from '../../../src/core/group/types.js';
import { PARSES_PER_RELEASE } from '../../../src/core/tree-sitter/native-tree-release.js';

const FILES = 3 * PARSES_PER_RELEASE;

const makeRepo = (repoPath: string): RepoHandle => ({
  id: 'sibling-tree-release',
  path: 'test/sibling-tree-release',
  repoPath,
  storagePath: path.join(repoPath, '.gitnexus'),
});

/** Run `fn` while a self-rescheduling `setImmediate` numbers event-loop turns. */
async function countingTurns<T>(fn: () => Promise<T>): Promise<T> {
  probe.turn = 0;
  probe.parseTurns = [];
  let running = true;
  const tick = (): void => {
    if (!running) return;
    probe.turn += 1;
    setImmediate(tick);
  };
  setImmediate(tick);
  try {
    return await fn();
  } finally {
    running = false;
  }
}

function maxParsesPerTurn(): number {
  const perTurn = new Map<number, number>();
  for (const turn of probe.parseTurns) perTurn.set(turn, (perTurn.get(turn) ?? 0) + 1);
  return Math.max(0, ...perTurn.values());
}

const CASES: Array<[string, () => ContractExtractor, (i: number) => [string, string]]> = [
  ['topic', () => new TopicExtractor(), (i) => [`src/T${i}.java`, `class T${i} {}\n`]],
  ['gRPC', () => new GrpcExtractor(), (i) => [`cmd/g${i}.go`, `package main\n\nfunc g${i}() {}\n`]],
  ['Thrift', () => new ThriftExtractor(), (i) => [`src/R${i}.java`, `class R${i} {}\n`]],
  [
    'include',
    () => new IncludeExtractor(),
    (i) => [`src/c${i}.c`, `#include "h${i}.h"\nint f${i}(void) { return ${i}; }\n`],
  ],
];

describe('sibling extractors release trees as they parse', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sibling-tree-release-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(CASES)('the %s extractor yields between parse batches', async (_name, make, file) => {
    for (let i = 0; i < FILES; i++) {
      const [rel, text] = file(i);
      fs.mkdirSync(path.dirname(path.join(tmpDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, rel), text);
    }

    await countingTurns(() => make().extract(null, tmpDir, makeRepo(tmpDir)));

    expect(probe.parseTurns.length).toBe(FILES);
    expect(maxParsesPerTurn()).toBeLessThanOrEqual(PARSES_PER_RELEASE);
  });
});
