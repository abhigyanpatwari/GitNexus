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
    const script = `
      import { PerformanceObserver, constants } from 'node:perf_hooks';
      const { nudgeV8 } = await import(${JSON.stringify(pathToFileURL(RELEASER_SOURCE).href)});
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
    `;
    const out = execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script],
      { encoding: 'utf8' },
    );
    const { withoutNudge, withNudge } = JSON.parse(out.trim().split('\n').at(-1) ?? '{}');
    expect(withoutNudge).toBe(0);
    expect(withNudge).toBeGreaterThan(0);
  });
});
