import { describe, expect, it, vi } from 'vitest';
import { prepareRouteConstantsByProvider } from '../../src/core/ingestion/language-provider.js';
import type {
  ModuleConstants,
  RepoConstants,
} from '../../src/core/ingestion/route-extractors/constant-resolver.js';

const constants = (): ModuleConstants => ({
  literals: new Map(),
  exprs: new Map(),
  imports: new Map(),
});

describe('prepareRouteConstantsByProvider', () => {
  it('calls each hook once with only that provider’s files', () => {
    const javaHook = vi.fn();
    const kotlinHook = vi.fn();
    const java = { prepareRouteConstants: javaHook };
    const kotlin = { prepareRouteConstants: kotlinHook };
    const python = {};
    const repo: RepoConstants = new Map([
      ['src/A.java', constants()],
      ['src/B.java', constants()],
      ['src/C.kt', constants()],
      ['src/d.py', constants()],
    ]);

    prepareRouteConstantsByProvider(repo, (filePath) => {
      if (filePath.endsWith('.java')) return java;
      if (filePath.endsWith('.kt')) return kotlin;
      return python;
    });

    expect(javaHook).toHaveBeenCalledTimes(1);
    expect([...javaHook.mock.calls[0][0].keys()]).toEqual(['src/A.java', 'src/B.java']);
    expect(kotlinHook).toHaveBeenCalledTimes(1);
    expect([...kotlinHook.mock.calls[0][0].keys()]).toEqual(['src/C.kt']);
  });
});
