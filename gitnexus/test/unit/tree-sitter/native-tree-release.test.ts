import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createTreeReleaser,
  MAX_YIELDS_PER_NUDGE,
  NUDGE_RSS_GROWTH_BYTES,
  PARSES_PER_RELEASE,
} from '../../../src/core/tree-sitter/native-tree-release.js';

const MB = 1024 * 1024;
const RELEASER_SOURCE = fileURLToPath(
  new URL('../../../src/core/tree-sitter/native-tree-release.ts', import.meta.url),
);

/**
 * Run an ES module script in a child Node process and return the JSON object it
 * prints last. The releaser has no imports, so the child loads its source
 * directly; the script finds the module's file URL in `RELEASER_URL`.
 */
function runReleaserChild(
  script: string,
  options: { nodeArgs?: string[]; nodeOptions?: string } = {},
): Record<string, unknown> {
  const out = execFileSync(
    process.execPath,
    [
      ...(options.nodeArgs ?? []),
      '--experimental-strip-types',
      '--no-warnings',
      '--input-type=module',
      '-e',
      `const RELEASER_URL = ${JSON.stringify(pathToFileURL(RELEASER_SOURCE).href)};\n${script}`,
    ],
    { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: options.nodeOptions ?? '' } },
  );
  return JSON.parse(out.trim().split('\n').at(-1) ?? '{}');
}

/** Queue a macrotask now and report whether it has run when asked. */
function macrotaskProbe(): () => boolean {
  let ran = false;
  setImmediate(() => {
    ran = true;
  });
  return () => ran;
}

describe('createTreeReleaser', () => {
  it('yields a macrotask only on every Nth call', async () => {
    const release = createTreeReleaser(3);

    const first = macrotaskProbe();
    await release();
    expect(first()).toBe(false);
    await release();
    expect(first()).toBe(false);

    // The third call must let an earlier-queued setImmediate run, which is the
    // phase in which Node runs pending tree-sitter finalizers.
    await release();
    expect(first()).toBe(true);

    const second = macrotaskProbe();
    await release();
    await release();
    expect(second()).toBe(false);
    await release();
    expect(second()).toBe(true);
  });

  it('defaults to PARSES_PER_RELEASE parses per yield', async () => {
    const release = createTreeReleaser();
    const probe = macrotaskProbe();
    for (let i = 1; i < PARSES_PER_RELEASE; i++) await release();
    expect(probe()).toBe(false);
    await release();
    expect(probe()).toBe(true);
  });

  /** A releaser that yields on every call, with scripted RSS and a counted nudge. */
  function scriptedReleaser(nudge: () => void = () => {}) {
    const state = { rss: 500 * MB, nudges: 0 };
    const release = createTreeReleaser(1, {
      readRss: () => state.rss,
      nudge: () => {
        state.nudges += 1;
        nudge();
      },
    });
    return { state, release };
  }

  it('measures RSS growth from the lowest RSS since the last nudge', async () => {
    const { state, release } = scriptedReleaser();

    state.rss += NUDGE_RSS_GROWTH_BYTES + MB;
    await release();
    expect(state.nudges).toBe(1);

    // After the nudge the GC frees the dead trees and RSS falls.
    state.rss = 300 * MB;
    await release();
    expect(state.nudges).toBe(1);

    // Regrowth from that low point nudges again, although RSS is still far
    // below where the last nudge happened.
    state.rss += NUDGE_RSS_GROWTH_BYTES + MB;
    await release();
    expect(state.nudges).toBe(2);
  });

  it('re-bases the RSS floor after a nudge, so flat RSS does not nudge again at once', async () => {
    const { state, release } = scriptedReleaser();
    state.rss += NUDGE_RSS_GROWTH_BYTES + MB;
    await release();
    expect(state.nudges).toBe(1);
    // RSS stays at the new level: measured from the old floor it would still
    // be over the threshold and nudge on every yield.
    for (let i = 1; i < MAX_YIELDS_PER_NUDGE; i++) await release();
    expect(state.nudges).toBe(1);
  });

  it('nudges every MAX_YIELDS_PER_NUDGE yields when RSS does not show the growth', async () => {
    // glibc reuses freed memory without RSS falling, so RSS can stay flat.
    const { state, release } = scriptedReleaser();
    for (let i = 1; i < MAX_YIELDS_PER_NUDGE; i++) await release();
    expect(state.nudges).toBe(0);
    await release();
    expect(state.nudges).toBe(1);
    for (let i = 0; i < MAX_YIELDS_PER_NUDGE; i++) await release();
    expect(state.nudges).toBe(2);
  });

  it('still yields when the nudge cannot allocate its buffer', async () => {
    const { state, release } = scriptedReleaser(() => {
      throw new RangeError('Array buffer allocation failed');
    });
    state.rss += NUDGE_RSS_GROWTH_BYTES + MB;
    const probe = macrotaskProbe();
    await release();
    expect(state.nudges).toBe(1);
    expect(probe()).toBe(true);
  });

  it('nudgeV8 makes V8 run a major GC', () => {
    // A child process, so that no other work in the test worker runs major GCs
    // of its own. The module has no imports, so Node loads the source directly.
    const { withoutNudge, withNudge } = runReleaserChild(`
      import { PerformanceObserver, constants } from 'node:perf_hooks';
      const { nudgeV8 } = await import(RELEASER_URL);
      let majors = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (e.detail?.kind === constants.NODE_PERFORMANCE_GC_MAJOR) majors += 1;
      }).observe({ entryTypes: ['gc'] });
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      // Light allocation between turns, as a parse loop does; V8 finishes its
      // incremental marking as the program allocates.
      const churn = () => { for (let k = 0; k < 200; k++) new Array(1000).fill(k); };
      const phase = async (nudge) => {
        const start = majors;
        for (let i = 0; i < 5; i++) {
          if (nudge) nudgeV8();
          for (let j = 0; j < 10; j++) { churn(); await new Promise((resolve) => setImmediate(resolve)); }
          await sleep(10);
        }
        return majors - start;
      };
      await sleep(50);
      const withoutNudge = await phase(false);
      const withNudge = await phase(true);
      console.log(JSON.stringify({ withoutNudge, withNudge }));
    `);
    expect(withoutNudge).toBe(0);
    expect(withNudge).toBeGreaterThan(0);
  });

  // Under --zero-fill-buffers a failed Buffer.allocUnsafeSlow aborts the process,
  // so nudgeV8 must use a plain ArrayBuffer there. Node accepts both spellings.
  it.each([
    ['no flag', {}, 1],
    ['--zero-fill-buffers', { nodeArgs: ['--zero-fill-buffers'] }, 0],
    ['--zero_fill_buffers', { nodeArgs: ['--zero_fill_buffers'] }, 0],
    ['NODE_OPTIONS=--zero-fill-buffers', { nodeOptions: '--zero-fill-buffers' }, 0],
    ['NODE_OPTIONS=--zero_fill_buffers', { nodeOptions: '--zero_fill_buffers' }, 0],
  ])('nudgeV8 picks its allocation for %s', (_label, options, expectedUnsafeAllocations) => {
    const { unsafeAllocations } = runReleaserChild(
      `
      let unsafeAllocations = 0;
      const allocUnsafeSlow = Buffer.allocUnsafeSlow;
      // Only the nudge's 64 MB allocation; Node itself makes small ones.
      Buffer.allocUnsafeSlow = (size) => {
        if (size === 64 * 1024 * 1024) unsafeAllocations += 1;
        return allocUnsafeSlow(size);
      };
      const { nudgeV8 } = await import(RELEASER_URL);
      nudgeV8();
      console.log(JSON.stringify({ unsafeAllocations }));
    `,
      options,
    );
    expect(unsafeAllocations).toBe(expectedUnsafeAllocations);
  });
});
