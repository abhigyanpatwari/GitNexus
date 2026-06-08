import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerSourceSinkConfig,
  getSourceSinkConfig,
  registeredTaintLanguages,
  clearSourceSinkRegistry,
} from '../../../src/core/ingestion/taint/source-sink-registry.js';
import type { SourceSinkSanitizerSpec } from '../../../src/core/ingestion/taint/source-sink-config.js';

const spec = (over: Partial<SourceSinkSanitizerSpec> = {}): SourceSinkSanitizerSpec => ({
  sources: [],
  sinks: [],
  sanitizers: [],
  ...over,
});

describe('source/sink/sanitizer registry seam (#2080)', () => {
  beforeEach(() => clearSourceSinkRegistry());

  it('is empty by default — no language registered (guards default-run parity)', () => {
    expect(registeredTaintLanguages()).toEqual([]);
    expect(getSourceSinkConfig('typescript')).toBeUndefined();
  });

  it('register then get round-trips the spec', () => {
    const ts = spec({ sinks: [{ name: 'eval' }], sources: [{ name: 'req.body', args: [0] }] });
    registerSourceSinkConfig('typescript', ts);
    expect(getSourceSinkConfig('typescript')).toBe(ts);
    expect(registeredTaintLanguages()).toEqual(['typescript']);
  });

  it('getSourceSinkConfig returns undefined for an unregistered language (never throws)', () => {
    registerSourceSinkConfig('typescript', spec());
    expect(getSourceSinkConfig('python')).toBeUndefined();
  });

  it('re-registering the same language id overwrites (last-write-wins)', () => {
    const first = spec({ sinks: [{ name: 'eval' }] });
    const second = spec({ sinks: [{ name: 'exec' }] });
    registerSourceSinkConfig('typescript', first);
    registerSourceSinkConfig('typescript', second);
    expect(getSourceSinkConfig('typescript')).toBe(second);
    expect(registeredTaintLanguages()).toEqual(['typescript']);
  });
});
