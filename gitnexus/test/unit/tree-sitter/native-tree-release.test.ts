import { describe, expect, it } from 'vitest';
import {
  createTreeReleaser,
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
});
