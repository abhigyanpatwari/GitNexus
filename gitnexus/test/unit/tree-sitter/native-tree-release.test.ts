import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createTreeReleaser,
  MAX_YIELDS_PER_NUDGE,
  NUDGE_RSS_GROWTH_BYTES,
  PARSES_PER_RELEASE,
  zeroFillBuffersRequested,
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

  it('lowers the RSS floor when RSS falls between nudges', async () => {
    // The floor starts at the RSS read when the releaser is made.
    const { state, release } = scriptedReleaser();
    state.rss = 300 * MB;
    await release();
    expect(state.nudges).toBe(0);
    // Growth from the new low nudges, although RSS is below the first reading.
    state.rss += NUDGE_RSS_GROWTH_BYTES + MB;
    await release();
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
      const { nudgeV8, holdNudgeBuffer } = await import(RELEASER_URL);
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
      const end = holdNudgeBuffer();
      const withNudge = await phase(true);
      end();
      console.log(JSON.stringify({ withoutNudge, withNudge }));
    `);
    // Not `withoutNudge === 0`: whether V8 runs a major GC of its own here
    // depends on its version.
    expect(Number(withNudge)).toBeGreaterThan(Number(withoutNudge));
  });

  it('nudgeV8 holds its buffer until the next nudge', () => {
    // A buffer dropped at once is freed by a minor GC and starts no major one
    // (see the module comment), so the nudge must keep it.
    const { afterFirst, afterSecond } = runReleaserChild(
      `
      const { nudgeV8, holdNudgeBuffer } = await import(RELEASER_URL);
      const end = holdNudgeBuffer();
      const arrayBuffers = () => { gc(); gc(); return process.memoryUsage().arrayBuffers; };
      nudgeV8();
      const afterFirst = arrayBuffers();
      nudgeV8();
      const afterSecond = arrayBuffers();
      end();
      console.log(JSON.stringify({ afterFirst, afterSecond }));
    `,
      { nodeArgs: ['--expose-gc'] },
    );
    expect(Number(afterFirst)).toBeGreaterThanOrEqual(64 * MB);
    // The second nudge replaces the first buffer instead of adding to it.
    expect(Number(afterSecond)).toBeGreaterThanOrEqual(64 * MB);
    expect(Number(afterSecond)).toBeLessThan(128 * MB);
  });

  it('shares one nudge buffer across standalone scans and frees it after the last scan', () => {
    const result = runReleaserChild(
      `
      const { createTreeReleaser, holdNudgeBuffer, MAX_YIELDS_PER_NUDGE } = await import(RELEASER_URL);
      const arrayBuffers = async () => {
        await new Promise(setImmediate);
        gc(); gc();
        return process.memoryUsage().arrayBuffers;
      };
      const scan = async (release) => {
        for (let i = 0; i < MAX_YIELDS_PER_NUDGE; i++) await release();
      };
      const baseline = await arrayBuffers();
      let first = createTreeReleaser(1);
      await scan(first);
      let second = createTreeReleaser(1);
      const endGroup = holdNudgeBuffer();
      await scan(second);
      const overlapping = await arrayBuffers();
      second = undefined;
      endGroup();
      const standalone = await arrayBuffers();
      await scan(first);
      first = undefined;
      const finished = await arrayBuffers();
      console.log(JSON.stringify({ overlapping: overlapping - baseline, standalone: standalone - baseline, finished: finished - baseline }));
    `,
      { nodeArgs: ['--expose-gc'] },
    );
    expect(result).toEqual({ overlapping: 64 * MB, standalone: 64 * MB, finished: 0 });
  });

  it('drops the nudge buffer when the last hold ends', () => {
    const { held, afterFirstEnd, afterLastEnd } = runReleaserChild(
      `
      const { nudgeV8, holdNudgeBuffer } = await import(RELEASER_URL);
      const arrayBuffers = () => { gc(); gc(); return process.memoryUsage().arrayBuffers; };
      const endFirst = holdNudgeBuffer();
      const endLast = holdNudgeBuffer();
      nudgeV8();
      const held = arrayBuffers();
      endFirst();
      endFirst();
      const afterFirstEnd = arrayBuffers();
      endLast();
      // WeakRef keeps a dereferenced target alive through the current job.
      await new Promise(setImmediate);
      const afterLastEnd = arrayBuffers();
      console.log(JSON.stringify({ held, afterFirstEnd, afterLastEnd }));
    `,
      { nodeArgs: ['--expose-gc'] },
    );
    // Ending one hold twice does not end the other.
    expect(Number(afterFirstEnd)).toBeGreaterThanOrEqual(64 * MB);
    expect(Number(held) - Number(afterLastEnd)).toBeGreaterThanOrEqual(64 * MB);
  });

  // Under --zero-fill-buffers a failed Buffer.allocUnsafeSlow aborts the process,
  // so nudgeV8 must use a plain ArrayBuffer there.
  it.each([
    ['no flag', {}, 1],
    ['a quoted flag in NODE_OPTIONS', { nodeOptions: '"--zero_fill_buffers"' }, 0],
    ['the flag on the command line', { nodeArgs: ['--zero-fill-buffers'] }, 0],
    [
      'the flag after an option value in NODE_OPTIONS',
      { nodeOptions: '--title gitnexus-test --zero-fill-buffers' },
      0,
    ],
  ])('nudgeV8 picks its allocation with %s', (_label, options, expectedUnsafeAllocations) => {
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

describe('zeroFillBuffersRequested', () => {
  // `$MODULE` stands for an empty module, for the options that load one, and
  // `$CONFIG` for a Node config file that turns zero-fill on.
  let fixtureDir: string;
  beforeAll(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-zero-fill-'));
    fs.writeFileSync(path.join(fixtureDir, 'empty.cjs'), '');
    fs.writeFileSync(
      path.join(fixtureDir, 'zero-fill.json'),
      JSON.stringify({ nodeOptions: { 'zero-fill-buffers': true } }),
    );
  });
  afterAll(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
  const fill = (arg: string): string =>
    arg
      .replace('$MODULE', path.join(fixtureDir, 'empty.cjs'))
      .replace('$CONFIG', path.join(fixtureDir, 'zero-fill.json'));

  // [NODE_OPTIONS, command-line options, the answer]. A wrong "on" only costs
  // memory and a wrong "off" can abort, so every mention counts as on, also
  // where Node ignores it or turns it off again.
  const CASES: Array<[string, string[], boolean]> = [
    ['', [], false],
    ['--max-old-space-size=100', ['--max-old-space-size=100'], false],
    ['--zero-fill-buffers', [], true],
    ['--zero_fill_buffers', [], true],
    ['"--zero-fill-buffers"', [], true],
    ['"--zero-"fill-buffers', [], true],
    ['"--zero-fill-\\buffers"', [], true],
    ['--max-old-space-size=100 "--zero-fill-buffers"', [], true],
    ['--zero-fill-buffers=false', [], true],
    ['', ['--zero-fill-buffers=true'], true],
    ['', ['--zero_fill_buffers=false'], true],
    ['--no-zero-fill-buffers', [], false],
    ['', ['--no-zero-fill-buffers'], false],
    // Node reads a separately given option value and goes on.
    ['--require $MODULE --zero-fill-buffers', [], true],
    ['-r $MODULE --zero-fill-buffers', [], true],
    ['--import $MODULE --zero-fill-buffers', [], true],
    ['--title x --zero-fill-buffers', [], true],
    ['--conditions x --zero-fill-buffers', [], true],
    ['--disable-warning x --zero-fill-buffers', [], true],
    // A config file can turn it on.
    ['', ['--experimental-config-file=$CONFIG'], true],
    ['', ['--experimental-config-file', '$CONFIG'], true],
    // Node says off for these; on is the safe side.
    ['--zero-fill-buffers --no-zero-fill-buffers', [], true],
    ['--zero-fill-buffers', ['--no-zero-fill-buffers'], true],
    ['x --zero-fill-buffers', [], true],
    ["'--zero-fill-buffers'", [], true],
    ['\t--zero-fill-buffers', [], true],
  ];

  it.each(CASES)('NODE_OPTIONS=%s with %j gives %s', (nodeOptions, execArgv, expected) => {
    expect(zeroFillBuffersRequested(execArgv.map(fill), fill(nodeOptions))).toBe(expected);
  });

  /** What Node itself decides; false when it rejects the options. */
  function nodeTurnsZeroFillOn(execArgv: string[], nodeOptions: string): boolean {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: nodeOptions };
    // A set NODE_OPTIONS, even an empty one, makes Node skip a config file's
    // `nodeOptions`.
    if (nodeOptions === '') delete env.NODE_OPTIONS;
    try {
      const out = execFileSync(
        process.execPath,
        [
          '--expose-internals',
          '--no-warnings',
          ...execArgv,
          '-e',
          "console.log(require('internal/options').getOptionValue('--zero-fill-buffers'))",
        ],
        { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return out.trim() === 'true';
    } catch {
      // For example a Node release without config files.
      return false;
    }
  }

  it('says on wherever Node itself turns zero-fill on', () => {
    let nodeOn = 0;
    for (const [rawOptions, rawArgv] of CASES) {
      const nodeOptions = fill(rawOptions);
      const execArgv = rawArgv.map(fill);
      if (!nodeTurnsZeroFillOn(execArgv, nodeOptions)) continue;
      nodeOn += 1;
      expect({
        nodeOptions,
        execArgv,
        ours: zeroFillBuffersRequested(execArgv, nodeOptions),
      }).toEqual({ nodeOptions, execArgv, ours: true });
    }
    // Node says on for every "on" row except the last five and, on a release
    // without config files, the two config rows; so the loop is not vacuous.
    expect(nodeOn).toBeGreaterThanOrEqual(CASES.filter(([, , on]) => on).length - 7);
  });
});
