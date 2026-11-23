import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import type { RepoMeta } from '../../src/storage/repo-meta.js';

const exec = promisify(execFile);
const helper = fileURLToPath(
  new URL('../helpers/java-overload-persistence-child.mjs', import.meta.url),
);
const fixture = fileURLToPath(
  new URL('../fixtures/lang-resolution/java-overload-types/', import.meta.url),
);
const prefix = 'Method:src/main/java/demo/LookupService.java:LookupService.';
const callers = {
  'find#1~Collection<Long>': ['find', 'listOrders', 'settle'],
  'find#1~Long': ['getOrder'],
  'resolve#1~String': ['byCode'],
  'resolve#1~Long': ['byId'],
  'count#1': ['count', 'summarize'],
  'count#2': ['summarize'],
} as const;
const targets = Object.keys(callers).map((suffix) => prefix + suffix);

interface AnalysisReceipt {
  usedWorkerPool: boolean;
  reparsed: number;
  hits: number;
  storagePath: string;
  meta: RepoMeta;
}
interface ImpactReceipt {
  error?: string;
  partial?: boolean;
  epistemic: string;
  causes?: { overloadResolution?: number };
  summary: { direct: number };
  byDepth: Record<string, Array<{ name: string }>>;
}

it('preserves original overload callers and omission receipts across cold, durable warm, and edited analyses', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gitnexus-java-overload-'));
  const repo = path.join(directory, 'repo');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GITNEXUS_HOME: path.join(directory, 'home'),
    GITNEXUS_SHARED_STORE: 'off',
    GITNEXUS_MEMORY: 'off',
    GITNEXUS_LANG: 'en',
    GITNEXUS_LBUG_EXTENSION_INSTALL: 'never',
    // Repeated impact traversals need more than the writer's 128 MiB minimum.
    GITNEXUS_LBUG_BUFFER_POOL_SIZE: '536870912',
  };
  delete env.GITNEXUS_STORAGE_PATH;
  delete env.GITNEXUS_STORAGE_ROOT;
  async function child<T>(action: 'analyze' | 'inspect'): Promise<T> {
    const { stdout } = await exec(
      process.execPath,
      [helper, JSON.stringify({ action, repo, targets })],
      {
        cwd: repo,
        env,
        timeout: 180_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const line = stdout.split('\n').find((value) => value.startsWith('JAVA_OVERLOAD_RESULT='));
    if (!line) throw new Error(`Missing child receipt: ${stdout}`);
    return JSON.parse(line.slice('JAVA_OVERLOAD_RESULT='.length)) as T;
  }
  function assertCallers(results: Record<string, ImpactReceipt>): void {
    for (const [suffix, expected] of Object.entries(callers)) {
      const result = results[prefix + suffix];
      expect(result, suffix).not.toHaveProperty('error');
      expect(result.partial, suffix).not.toBe(true);
      expect(result.summary.direct, suffix).toBe(expected.length);
      expect((result.byDepth['1'] ?? []).map((caller) => caller.name).sort(), suffix).toEqual(
        [...expected].sort(),
      );
    }
  }
  try {
    await cp(fixture, repo, { recursive: true });
    await exec('git', ['init', '-q', repo]);
    const cold = await child<AnalysisReceipt>('analyze');
    expect(cold.usedWorkerPool).toBe(true);
    expect(cold.reparsed).toBe(5);
    expect(cold.hits).toBe(0);
    const coldResults = await child<Record<string, ImpactReceipt>>('inspect');
    assertCallers(coldResults);
    for (const result of Object.values(coldResults)) {
      expect(result.causes?.overloadResolution ?? 0).toBe(0);
      expect(result.epistemic).toBe('exact');
    }

    // A fresh analyzer process consumes only durable ParsedFile sidechannels.
    // Force bypasses the up-to-date shortcut without discarding parser caches.
    const warm = await child<AnalysisReceipt>('analyze');
    expect(warm.usedWorkerPool).toBe(false);
    expect(warm.reparsed).toBe(0);
    expect(warm.hits).toBe(5);
    const warmResults = await child<Record<string, ImpactReceipt>>('inspect');
    assertCallers(warmResults);
    for (const uid of targets) {
      expect(warmResults[uid].epistemic).toBe(coldResults[uid].epistemic);
      expect(warmResults[uid].causes).toEqual(coldResults[uid].causes);
    }

    // External.value() has no available return type. Neither overload can be
    // chosen; known callers stay intact and each queried candidate is hedged.
    const unknownPath = path.join(repo, 'src/main/java/demo/UnknownCalls.java');
    const unknownSource = `package demo;
class UnknownCalls {
  LookupService lookup;
  Perm unknown() { return lookup.resolve(External.value()); }
}
`;
    await writeFile(unknownPath, unknownSource);
    const unresolved = await child<AnalysisReceipt>('analyze');
    expect(unresolved.meta.unresolvedOverloads?.totalSites).toBeGreaterThan(0);
    const uncertainResults = await child<Record<string, ImpactReceipt>>('inspect');
    assertCallers(uncertainResults);
    for (const suffix of ['resolve#1~String', 'resolve#1~Long']) {
      expect(uncertainResults[prefix + suffix]).toMatchObject({
        epistemic: 'lower-bound',
        causes: { overloadResolution: 1 },
      });
    }

    // Correcting a retained file must replace its old omission receipt and
    // persist the newly proven edge, even while all other parse entries hit.
    await writeFile(
      unknownPath,
      `package demo;
class UnknownCalls {
  LookupService lookup;
  Perm unknown() { return lookup.resolve("known"); }
}
`,
    );
    const correction = await child<AnalysisReceipt>('analyze');
    expect(correction.reparsed).toBe(1);
    expect(correction.hits).toBe(5);
    const corrected = await child<Record<string, ImpactReceipt>>('inspect');
    for (const uid of targets) expect(corrected[uid].partial, uid).not.toBe(true);
    expect(corrected[prefix + 'resolve#1~String'].summary.direct).toBe(2);
    expect(
      corrected[prefix + 'resolve#1~String'].byDepth['1'].map((caller) => caller.name).sort(),
    ).toEqual(['byCode', 'unknown']);
    expect(corrected[prefix + 'resolve#1~Long'].summary.direct).toBe(1);
    for (const uid of targets) {
      expect(corrected[uid].epistemic).toBe(coldResults[uid].epistemic);
      expect(corrected[uid].causes).toEqual(coldResults[uid].causes);
    }

    // Delete a file with a persisted unresolved call, so stale omission
    // metadata cannot hide behind the earlier correction's empty receipt.
    await writeFile(unknownPath, unknownSource);
    const unresolvedAgain = await child<AnalysisReceipt>('analyze');
    expect(unresolvedAgain.meta.unresolvedOverloads?.totalSites).toBeGreaterThan(0);
    await rm(unknownPath);
    const deletion = await child<AnalysisReceipt>('analyze');
    expect(deletion.meta.unresolvedOverloads).toMatchObject({
      complete: true,
      totalSites: 0,
      omittedSites: 0,
      sites: [],
    });
    const restored = await child<Record<string, ImpactReceipt>>('inspect');
    assertCallers(restored);
    for (const uid of targets) {
      expect(restored[uid].epistemic).toBe(coldResults[uid].epistemic);
      expect(restored[uid].causes).toEqual(coldResults[uid].causes);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 600_000);
