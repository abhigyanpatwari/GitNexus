import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Parser from 'tree-sitter';
import { SWIFT_HTTP_PLUGIN } from '../../../src/core/group/extractors/http-patterns/swift.js';
import { getPluginForFile } from '../../../src/core/group/extractors/http-patterns/index.js';
import { HttpRouteExtractor } from '../../../src/core/group/extractors/http-route-extractor.js';

// tree-sitter-swift is vendored; skip rather than fail where its native
// binding is unavailable, the same way the Kotlin suites do.
const describeSwift = SWIFT_HTTP_PLUGIN ? describe : describe.skip;

function plugin() {
  if (!SWIFT_HTTP_PLUGIN) throw new Error('tree-sitter-swift unavailable');
  return SWIFT_HTTP_PLUGIN;
}

describeSwift('Swift HTTP consumer plugin (#1677)', () => {
  const parser = new Parser();
  if (SWIFT_HTTP_PLUGIN) parser.setLanguage(SWIFT_HTTP_PLUGIN.language);

  const scan = (body: string) =>
    plugin()
      .scan(parser.parse(`func caller() async throws {\n${body}\n}\n`))
      .map(({ method, path, framework }) => ({ method, path, framework }));

  it('is registered for .swift files', () => {
    expect(getPluginForFile('Sources/App/RelayClient.swift')).toBe(SWIFT_HTTP_PLUGIN);
  });

  it('reads the verb from a wrapper method name and the path from a labeled path: argument', () => {
    expect(
      scan(`
        _ = try await RelayClient.get(path: "/api/customers")
        _ = try await RelayClient.post(path: "/api/devices/register", body: Data())
      `),
    ).toEqual([
      { method: 'GET', path: '/api/customers', framework: 'swift-wrapper' },
      { method: 'POST', path: '/api/devices/register', framework: 'swift-wrapper' },
    ]);
  });

  it('reads a positional first argument and a labeled url: argument', () => {
    expect(
      scan(`
        _ = try await client.put("/api/users/me", body: data)
        _ = try await client.delete(id: 3, url: "https://api.example.com/v1/items")
      `),
    ).toEqual([
      { method: 'PUT', path: '/api/users/me', framework: 'swift-wrapper' },
      { method: 'DELETE', path: 'https://api.example.com/v1/items', framework: 'swift-wrapper' },
    ]);
  });

  it('turns string interpolation into ${} placeholders the normalizer understands', () => {
    expect(
      scan(`
        _ = try await api.patch(path: "/api/users/\\(user.id)/settings")
        _ = try await api.get("\\(baseURL)/api/orders")
      `),
    ).toEqual([
      { method: 'PATCH', path: '/api/users/${p}/settings', framework: 'swift-wrapper' },
      { method: 'GET', path: '${p}/api/orders', framework: 'swift-wrapper' },
    ]);
  });

  it('reads Alamofire request verbs, defaulting to GET and widening a variable verb to *', () => {
    expect(
      scan(`
        AF.request("https://api.example.com/v1/items")
        AF.request("/v1/items", method: .post, parameters: p)
        session.request("/v1/items/\\(id)", method: HTTPMethod.delete)
        AF.request("/v1/items", method: verb)
      `),
    ).toEqual([
      { method: 'GET', path: 'https://api.example.com/v1/items', framework: 'swift-request' },
      { method: 'POST', path: '/v1/items', framework: 'swift-request' },
      { method: 'DELETE', path: '/v1/items/${p}', framework: 'swift-request' },
      { method: '*', path: '/v1/items', framework: 'swift-request' },
    ]);
  });

  it('defaults request to GET only on Alamofire AF, not on arbitrary wrappers', () => {
    expect(
      scan(`
        Alamofire.AF.request("/v1/items")
        _ = try await client.request("/v1/items")
        _ = try await session.request(path: "/v1/items")
      `),
    ).toEqual([
      { method: 'GET', path: '/v1/items', framework: 'swift-request' },
      { method: '*', path: '/v1/items', framework: 'swift-request' },
      { method: '*', path: '/v1/items', framework: 'swift-request' },
    ]);
  });

  it('reads a labeled string method: and path: on a request wrapper', () => {
    expect(
      scan(`
        _ = try await client.request(method: "POST", path: "/api/users")
        _ = try await client.request(method: "patch", url: "/api/users/\\(id)")
      `),
    ).toEqual([
      { method: 'POST', path: '/api/users', framework: 'swift-request' },
      { method: 'PATCH', path: '/api/users/${p}', framework: 'swift-request' },
    ]);
  });

  it('ignores calls whose literal is not a URL path, and non-literal paths', () => {
    expect(
      scan(`
        let token = cache.get("authToken")
        _ = try await client.get("//api.example.com/v1/items")
        _ = try await client.get("\\(base)//v1/items")
        defaults.post("didLogin")
        _ = try await client.get(path: endpoint)
        _ = try await client.get(User.self, "/api/users")
        _ = get("/api/users")
        _ = client.fetch("/api/users")
      `),
    ).toEqual([]);
  });

  it('reports the call-site line, not the line of a wrapped path argument', () => {
    const tree = parser.parse(
      'func a() {}\nfunc b() async throws {\n  _ = try await c.post(\n    path: "/x",\n    body: d\n  )\n}\n',
    );
    expect(plugin().scan(tree)[0].line).toBe(3);
  });
});

describeSwift('HttpRouteExtractor with Swift sources', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('emits normalized consumer contracts from a .swift file', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-swift-http-'));
    fs.mkdirSync(path.join(dir, 'Sources'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'Sources/RelayClient.swift'),
      `import Foundation

enum RelayClient {
    static func get(path: String) async throws -> Data { Data() }
    static func post(path: String, body: Data) async throws -> Data { Data() }
}

func loadCustomer(id: Int) async throws {
    _ = try await RelayClient.get(path: "/api/customers/\\(id)")
    _ = try await RelayClient.post(path: "/api/devices/register", body: Data())
}
`,
    );

    const contracts = await new HttpRouteExtractor().extract(null, dir, {
      id: 'ios-app',
      path: 'test/ios',
      repoPath: dir,
      storagePath: path.join(dir, '.gitnexus'),
    });
    const ids = contracts
      .filter((c) => c.role === 'consumer')
      .map((c) => c.contractId)
      .sort();
    expect(ids).toEqual(['http::GET::/api/customers/{param}', 'http::POST::/api/devices/register']);
  });
});
