import { describe, expect, it } from 'vitest';
import {
  assertKnownMcpToolArguments,
  foldNumericToolArgumentAliases,
  suggestKnownToolArgument,
} from '../../src/mcp/tool-arguments.js';
import { GITNEXUS_TOOLS } from '../../src/mcp/tools.js';

const impactProperties = GITNEXUS_TOOLS.find((tool) => tool.name === 'impact')!.inputSchema
  .properties;

describe('assertKnownMcpToolArguments (#3261)', () => {
  it('allows advertised impact keys including the depth alias', () => {
    expect(() =>
      assertKnownMcpToolArguments(
        'impact',
        { target: 'auth', direction: 'downstream', depth: 2 },
        impactProperties,
      ),
    ).not.toThrow();
  });

  it('rejects an unknown key and names it', () => {
    expect(() =>
      assertKnownMcpToolArguments(
        'impact',
        { target: 'auth', direction: 'downstream', notARealArg: 2 },
        impactProperties,
      ),
    ).toThrow(/Unknown argument "notARealArg" for tool "impact"/);
  });

  it('suggests maxDepth for the snake_case misspelling', () => {
    expect(() =>
      assertKnownMcpToolArguments(
        'impact',
        { target: 'auth', direction: 'downstream', max_depth: 2 },
        impactProperties,
      ),
    ).toThrow(/Did you mean "maxDepth"/);
  });

  it('still accepts the unpublished query alias (#2175)', () => {
    const queryProperties = GITNEXUS_TOOLS.find((tool) => tool.name === 'query')!.inputSchema
      .properties;
    expect(() =>
      assertKnownMcpToolArguments('query', { query: 'auth' }, queryProperties),
    ).not.toThrow();
    const cypherProperties = GITNEXUS_TOOLS.find((tool) => tool.name === 'cypher')!.inputSchema
      .properties;
    expect(() =>
      assertKnownMcpToolArguments('cypher', { query: 'MATCH (n) RETURN n' }, cypherProperties),
    ).not.toThrow();
  });

  it('still accepts unpublished query on the legacy search name', () => {
    const queryProperties = GITNEXUS_TOOLS.find((tool) => tool.name === 'query')!.inputSchema
      .properties;
    expect(() =>
      assertKnownMcpToolArguments('search', { query: 'auth' }, queryProperties),
    ).not.toThrow();
  });

  it('still accepts unpublished context target (group-mode alias)', () => {
    const contextProperties = GITNEXUS_TOOLS.find((tool) => tool.name === 'context')!.inputSchema
      .properties;
    expect(() =>
      assertKnownMcpToolArguments('context', { repo: '@g1', target: 'Sym' }, contextProperties),
    ).not.toThrow();
    expect(() =>
      assertKnownMcpToolArguments('explore', { repo: '@g1', target: 'Sym' }, contextProperties),
    ).not.toThrow();
  });

  it('does not suggest the unpublished query alias (#2175)', () => {
    const queryProperties = GITNEXUS_TOOLS.find((tool) => tool.name === 'query')!.inputSchema
      .properties;
    expect(() => assertKnownMcpToolArguments('query', { Query: 'auth' }, queryProperties)).toThrow(
      /Unknown argument "Query" for tool "query"/,
    );
    expect(() =>
      assertKnownMcpToolArguments('query', { Query: 'auth' }, queryProperties),
    ).not.toThrow(/Did you mean "query"/);
  });

  it('skips tools that have no advertised schema', () => {
    expect(() =>
      assertKnownMcpToolArguments('overview', { showClusters: true, extra: 1 }),
    ).not.toThrow();
  });
});

describe('suggestKnownToolArgument', () => {
  it('matches underscore and case folding', () => {
    expect(suggestKnownToolArgument('max_depth', ['maxDepth', 'target'])).toBe('maxDepth');
  });
});

describe('foldNumericToolArgumentAliases', () => {
  it('folds depth onto maxDepth', () => {
    expect(foldNumericToolArgumentAliases('impact', { target: 'auth', depth: 2 })).toEqual({
      params: { target: 'auth', maxDepth: 2 },
    });
  });

  it('keeps an agreed depth and maxDepth', () => {
    expect(foldNumericToolArgumentAliases('impact', { maxDepth: 2, depth: 2 })).toEqual({
      params: { maxDepth: 2 },
    });
  });

  it('rejects conflicting depth and maxDepth', () => {
    expect(foldNumericToolArgumentAliases('impact', { maxDepth: 3, depth: 1 })).toEqual({
      error: 'Conflicting MCP parameters for impact.maxDepth: maxDepth, depth must agree.',
    });
  });

  it('rejects a non-numeric depth', () => {
    expect(foldNumericToolArgumentAliases('trace', { depth: '2' })).toEqual({
      error: 'MCP parameter trace.depth must be a number.',
    });
  });

  it('treats literal 0 as an omitted adapter sentinel (#2279)', () => {
    expect(foldNumericToolArgumentAliases('impact', { maxDepth: 2, depth: 0 })).toEqual({
      params: { maxDepth: 2 },
    });
    expect(foldNumericToolArgumentAliases('impact', { target: 'auth', depth: 0 })).toEqual({
      params: { target: 'auth' },
    });
  });

  it('treats NaN maxDepth as omitted so trace keeps its default-depth contract', () => {
    expect(
      foldNumericToolArgumentAliases('trace', { from: 'A', to: 'B', maxDepth: Number.NaN }),
    ).toEqual({ params: { from: 'A', to: 'B' } });
    expect(foldNumericToolArgumentAliases('trace', { maxDepth: Number.NaN, depth: 2 })).toEqual({
      params: { maxDepth: 2 },
    });
  });

  it('keeps a negative depth so the handler applies its own default', () => {
    expect(foldNumericToolArgumentAliases('trace', { depth: -5 })).toEqual({
      params: { maxDepth: -5 },
    });
  });
});
