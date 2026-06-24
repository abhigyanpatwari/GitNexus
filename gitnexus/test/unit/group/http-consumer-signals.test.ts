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
import { JAVA_HTTP_PLUGIN } from '../../../src/core/group/extractors/http-patterns/java.js';
import { PHP_HTTP_PLUGIN } from '../../../src/core/group/extractors/http-patterns/php.js';
import { PYTHON_HTTP_PLUGIN } from '../../../src/core/group/extractors/http-patterns/python.js';

const has = (plugin: { hasConsumerSignals?: (s: string) => boolean }, src: string): boolean => {
  if (!plugin.hasConsumerSignals) throw new Error('plugin has no hasConsumerSignals');
  return plugin.hasConsumerSignals(src);
};

describe('Java hasConsumerSignals — superset of scan() consumer idioms', () => {
  it.each([
    ['RestTemplate', 'restTemplate.getForObject("/api/x", X.class);'],
    ['WebClient short-form', 'webClient.get().uri("/api/x").retrieve();'],
    ['WebClient exchange', 'webClient.method(HttpMethod.GET).uri("/x");'],
    ['OkHttp', 'new Request.Builder().url("/api/x").build();'],
    ['Java HttpClient', 'HttpRequest.newBuilder().uri(URI.create("/x")).GET();'],
    ['Apache HttpGet', 'new HttpGet("/api/x");'],
    ['OpenFeign @FeignClient', '@FeignClient(name="svc") interface C {}'],
    ['OpenFeign @RequestLine', '@RequestLine("GET /users/{id}")'],
    ['Spring HTTP Interface @GetExchange', '@GetExchange("/api/x") Object x();'],
  ])('detects %s', (_label, src) => {
    expect(has(JAVA_HTTP_PLUGIN, src)).toBe(true);
  });

  it('returns false for a pure provider controller (no outbound calls)', () => {
    const src = `@RestController @RequestMapping("/api/a")
class AController { @GetMapping("/list") Object list() { return null; } }`;
    expect(has(JAVA_HTTP_PLUGIN, src)).toBe(false);
  });
});

describe('PHP hasConsumerSignals — superset of scan() consumer idioms', () => {
  it.each([
    ['Laravel Http facade', "Http::get('/api/x');"],
    ['Guzzle member call', "$client->post('/api/x', []);"],
    ['file_get_contents', "file_get_contents('https://x/api');"],
  ])('detects %s', (_label, src) => {
    expect(has(PHP_HTTP_PLUGIN, src)).toBe(true);
  });

  it('returns false for a pure Laravel route file (provider only)', () => {
    expect(has(PHP_HTTP_PLUGIN, "Route::get('/api/a/list', 'AController@list');")).toBe(false);
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
