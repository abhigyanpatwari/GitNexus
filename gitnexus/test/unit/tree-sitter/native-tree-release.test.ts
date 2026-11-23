import { describe, expect, it } from 'vitest';
import {
  createTreeReleaser,
  NUDGE_RSS_GROWTH_BYTES,
  PARSES_PER_RELEASE,
} from '../../../src/core/tree-sitter/native-tree-release.js';

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

  it('nudges the GC only when RSS has grown past the threshold since the last nudge', async () => {
    const MB = 1024 * 1024;
    let rss = 500 * MB;
    let rssReads = 0;
    let nudges = 0;
    const release = createTreeReleaser(2, {
      readRss: () => {
        rssReads += 1;
        return rss;
      },
      nudge: () => {
        nudges += 1;
      },
    });
    expect(rssReads).toBe(1);

    // Only every 2nd call looks at RSS.
    rss += NUDGE_RSS_GROWTH_BYTES + MB;
    await release();
    expect(rssReads).toBe(1);
    expect(nudges).toBe(0);
    await release();
    expect(rssReads).toBe(2);
    expect(nudges).toBe(1);

    // Growth is measured from the last nudge, not from the start.
    rss += NUDGE_RSS_GROWTH_BYTES - MB;
    await release();
    await release();
    expect(nudges).toBe(1);
    rss += 2 * MB;
    await release();
    await release();
    expect(nudges).toBe(2);

    // A drop in RSS never nudges.
    rss -= 10 * NUDGE_RSS_GROWTH_BYTES;
    await release();
    await release();
    expect(nudges).toBe(2);
  });
});
