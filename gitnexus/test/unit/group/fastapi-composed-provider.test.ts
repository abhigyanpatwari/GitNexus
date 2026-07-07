/**
 * Group HTTP-contract layer: FastAPI provider detections for non-literal decorator
 * paths (#2391 U5). Exercises `PYTHON_HTTP_PLUGIN.prepareRepo` + `scan` directly
 * with a real tree-sitter parser (no DB / extractor machinery), asserting:
 *   • an imported/composed constant resolves to the same path the ingestion side
 *     produces (R4 parity), including APIRouter(prefix=…) stacking;
 *   • string-literal routes are unchanged;
 *   • an unresolvable argument emits NO provider (skip parity with ingestion);
 *   • the cost gate: a literal-only repo builds no constant map (no extra parse).
 */

import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import { PYTHON_HTTP_PLUGIN } from '../../../src/core/group/extractors/http-patterns/python.js';
import type { HttpDetection } from '../../../src/core/group/extractors/http-patterns/types.js';

const parser = new Parser();
const parseSource = (p: Parser, src: string): Parser.Tree => {
  p.setLanguage(Python);
  return p.parse(src);
};

interface RunResult {
  providers: { method: string; path: string }[];
  parseCalls: number;
}

function run(files: Record<string, string>): RunResult {
  let parseCalls = 0;
  const countingParse = (p: Parser, src: string): Parser.Tree => {
    parseCalls++;
    return parseSource(p, src);
  };
  const readFile = (rel: string): string | null => files[rel] ?? null;
  const ctx = PYTHON_HTTP_PLUGIN.prepareRepo?.({
    files: Object.keys(files),
    parser,
    readFile,
    parseSource: countingParse,
  });
  const providers: { method: string; path: string }[] = [];
  for (const rel of Object.keys(files)) {
    if (!rel.endsWith('.py')) continue;
    const detections: HttpDetection[] = PYTHON_HTTP_PLUGIN.scan(
      parseSource(parser, files[rel]),
      ctx,
      rel,
    );
    for (const d of detections) {
      if (d.role === 'provider') providers.push({ method: d.method, path: d.path });
    }
  }
  return { providers, parseCalls };
}

const CONSTANTS = [
  'API_V1 = "/api/v1"',
  'API_V1_WIDGETS = API_V1 + "/widgets"',
  'API_V1_WIDGETS_GET = API_V1_WIDGETS + "/get"',
].join('\n');

describe('group FastAPI composed-constant providers (#2391)', () => {
  it('resolves an imported composed constant to its full path', () => {
    const { providers } = run({
      'app/constants.py': CONSTANTS,
      'app/routes.py': [
        'from fastapi import APIRouter',
        'from .constants import API_V1_WIDGETS_GET',
        'router = APIRouter()',
        '@router.post(API_V1_WIDGETS_GET)',
        'async def create(): return {}',
      ].join('\n'),
    });
    expect(providers).toContainEqual({ method: 'POST', path: '/api/v1/widgets/get' });
  });

  it('stacks an APIRouter(prefix=…) onto a resolved composed path', () => {
    const { providers } = run({
      'app/constants.py': CONSTANTS,
      'app/routes.py': [
        'from fastapi import APIRouter',
        'from .constants import API_V1_WIDGETS_GET',
        'router = APIRouter(prefix="/v2")',
        '@router.post(API_V1_WIDGETS_GET)',
        'async def create(): return {}',
      ].join('\n'),
    });
    expect(providers).toContainEqual({ method: 'POST', path: '/v2/api/v1/widgets/get' });
  });

  it('leaves a string-literal route unchanged and emits no provider for an unresolvable arg', () => {
    const { providers } = run({
      'app/routes.py': [
        'from fastapi import APIRouter',
        'router = APIRouter()',
        '@router.get("/literal/health")',
        'async def health(): return {}',
        '@router.delete(UNKNOWN_CONST)',
        'async def remove(): return {}',
      ].join('\n'),
    });
    expect(providers).toContainEqual({ method: 'GET', path: '/literal/health' });
    expect(providers.some((p) => p.method === 'DELETE')).toBe(false);
  });

  it('cost gate: a literal-only repo parses no files for constants', () => {
    // No non-literal decorator and no include_router ⇒ prepareRepo does zero
    // parsing (the constant map is never built).
    const { parseCalls } = run({
      'app/routes.py': [
        'from fastapi import APIRouter',
        'router = APIRouter()',
        '@router.get("/only/literal")',
        'async def f(): return {}',
      ].join('\n'),
    });
    expect(parseCalls).toBe(0);
  });

  it('cost gate: a composed repo does parse for constants', () => {
    const { parseCalls } = run({
      'app/constants.py': CONSTANTS,
      'app/routes.py': '@router.post(API_V1_WIDGETS_GET)\nasync def f(): return {}\n',
    });
    expect(parseCalls).toBeGreaterThan(0);
  });
});
