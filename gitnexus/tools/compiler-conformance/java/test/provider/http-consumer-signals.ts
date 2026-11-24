import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JAVA_HTTP_PLUGIN } from '../../../../../src/core/group/extractors/http-patterns/java.js';

describe('Java HTTP consumer signals', () => {
  for (const [name, source] of [
    ['RestTemplate', 'restTemplate.getForObject("/api/x", X.class);'],
    ['WebClient short-form', 'webClient.get().uri("/api/x").retrieve();'],
    ['WebClient exchange', 'webClient.method(HttpMethod.GET).uri("/x");'],
    ['OkHttp', 'new Request.Builder().url("/api/x").build();'],
    ['Java HttpClient', 'HttpRequest.newBuilder().uri(URI.create("/x")).GET();'],
    ['Apache HttpGet', 'new HttpGet("/api/x");'],
    ['OpenFeign @FeignClient', '@FeignClient(name="svc") interface C {}'],
    ['OpenFeign @RequestLine', '@RequestLine("GET /users/{id}")'],
    ['Spring HTTP Interface @GetExchange', '@GetExchange("/api/x") Object x();'],
  ]) {
    it('detects ' + name, () => assert.equal(JAVA_HTTP_PLUGIN.hasConsumerSignals?.(source), true));
  }
  it('returns false for a pure provider controller (no outbound calls)', () => {
    const source = `@RestController @RequestMapping("/api/a")
class AController { @GetMapping("/list") Object list() { return null; } }`;
    assert.equal(JAVA_HTTP_PLUGIN.hasConsumerSignals?.(source), false);
  });
});
