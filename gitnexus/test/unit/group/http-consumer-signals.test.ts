/**
 * Unit tests for `HttpLanguagePlugin.hasConsumerSignals` (#2138 Part 2).
 *
 * The parse-skip consumer-safety gate skips a provider-covered file only when
 * its plugin proves (parse-free) the file has no outbound-HTTP call its `scan()`
 * would detect. The contract (`types.ts`) requires `hasConsumerSignals` to be a
 * SUPERSET of every consumer shape `scan()` emits — otherwise a covered file
 * with an undetected consumer call would be wrongly parse-skipped and its
 * consumer contract dropped. These tests pin that superset relationship per
 * language with the exact idioms each `scan()` matches.
 */
import { describe, it, expect } from 'vitest';
import { PHP_HTTP_PLUGIN } from '../../../src/core/group/extractors/http-patterns/php.js';
import { PYTHON_HTTP_PLUGIN } from '../../../src/core/group/extractors/http-patterns/python.js';

const has = (plugin: { hasConsumerSignals?: (s: string) => boolean }, src: string): boolean => {
  if (!plugin.hasConsumerSignals) throw new Error('plugin has no hasConsumerSignals');
  return plugin.hasConsumerSignals(src);
};

describe('PHP hasConsumerSignals — superset of scan() consumer idioms', () => {
  it.each([
    ['Laravel Http facade', "Http::get('/api/x');"],
    ['Guzzle member call', "$client->post('/api/x', []);"],
    ['file_get_contents', "file_get_contents('https://x/api');"],
    ['bare Request constructor', 'new Request($method, $host . $resourcePath);'],
    ['namespaced Request constructor', "new Foo\\Bar\\Request('GET', $url);"],
  ])('detects %s', (_label, src) => {
    expect(has(PHP_HTTP_PLUGIN, src)).toBe(true);
  });

  it('returns false for a pure Laravel route file (provider only)', () => {
    expect(has(PHP_HTTP_PLUGIN, "Route::get('/api/a/list', 'AController@list');")).toBe(false);
  });

  it('returns false for an unrelated constructor call (not *Request)', () => {
    expect(has(PHP_HTTP_PLUGIN, 'new Response($body, 200);')).toBe(false);
  });
});

describe('Python hasConsumerSignals — superset of scan() consumer idioms', () => {
  it.each([
    ['requests verb', 'requests.get("/api/x")'],
    ['requests.request', 'requests.request("GET", "/api/x")'],
    ['httpx', 'client = httpx.AsyncClient()'],
    ['aiohttp', 'async with aiohttp.ClientSession() as s: ...'],
    ['urllib', 'urllib.request.urlopen("/api/x")'],
    ['uri= keyword', 'do_call(uri="/api/x")'],
    ['url= keyword', 'do_call(url="/api/x")'],
  ])('detects %s', (_label, src) => {
    expect(has(PYTHON_HTTP_PLUGIN, src)).toBe(true);
  });

  it('returns false for a pure FastAPI provider (decorator route only)', () => {
    const src = `@router.get("/api/x")
async def handler(): return {}`;
    expect(has(PYTHON_HTTP_PLUGIN, src)).toBe(false);
  });
});
