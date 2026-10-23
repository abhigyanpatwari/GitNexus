import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import { createFetchWrapperContext } from '../../src/core/ingestion/route-extractors/fetch-wrapper.js';
import { buildFetchWrapperIndex } from '../../src/core/ingestion/route-extractors/fetch-wrapper-index.js';
import { normalizeFetchURL } from '../../src/core/ingestion/route-extractors/nextjs.js';

import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';
import {
  typescriptProvider,
  javascriptProvider,
} from '../../src/core/ingestion/languages/typescript.js';

const grammars = [
  ['JavaScript', JavaScript, javascriptProvider],
  ['TypeScript', TypeScript.typescript, typescriptProvider],
  ['TSX', TypeScript.tsx, typescriptProvider],
] as const;

function harness(grammar: (typeof grammars)[number][1], provider: (typeof grammars)[number][2]) {
  const parser = new Parser();
  parser.setLanguage(grammar);
  const context = (source: string, filePath = 'consumer.ts', lineOffset = 0) => {
    const fullSource = '\n'.repeat(lineOffset) + source;
    const tree = parser.parse(source);
    const parsedFile = extractParsedFile(
      provider,
      fullSource,
      filePath,
      undefined,
      parser.parse(fullSource),
    )!;
    return {
      root: tree.rootNode,
      context: createFetchWrapperContext(tree, parsedFile, lineOffset),
    };
  };
  const extract = (source: string, lineOffset = 0) =>
    context(source, 'consumer.ts', lineOffset).context.calls();
  return { context, extract };
}

for (const [name, grammar, provider] of grammars) {
  describe(`${name} fetch wrapper calls`, () => {
    const { context, extract } = harness(grammar, provider);

    it.each([
      {
        shape: 'literal concatenation',
        source: `function request(path) { return fetch('/api' + path); }`,
        expected: ['/api/models'],
      },
      {
        shape: 'a stable local prefix and URL alias',
        source: `function request(path) { const prefix = '/api'; const url = prefix + path; return fetch(url); }`,
        expected: ['/api/models'],
      },
      {
        shape: 'a returned URL through a helper chain',
        source: `function prefix(path) { return '/api' + path; }
          function build(path) { return prefix(path); }
          function request(path) { const url = build(path); return fetch(url); }`,
        expected: ['/api/models'],
      },
      {
        shape: 'a transformed argument forwarded to another wrapper',
        source: `function send(path) { return fetch(path); }
          function request(path) { return send('/api' + path); }`,
        expected: ['/api/models'],
      },
      {
        shape: 'a mount prefix inside a reachable retry callback',
        source: `function request(path) { return retry(() => fetch('/api' + path)); }`,
        expected: ['/api/models'],
      },
      {
        shape: 'an unused nested fetch helper',
        source: `function request(path) { const unused = () => fetch('/api' + path); return path; }`,
        expected: [],
      },
      {
        shape: 'startsWith with an explicit offset',
        source: `function build(path) { const normalized = path.startsWith('/', 1) ? path : '/' + path; return '/api' + normalized; }
          function request(path) { return fetch(build(path)); }`,
        expected: [],
      },
      {
        shape: 'a rebound prefix',
        source: `function request(path) { let prefix = '/api'; prefix = runtime(); return fetch(prefix + path); }`,
        expected: [],
      },
      {
        shape: 'a rebound URL parameter',
        source: `function request(path) { path = runtime(); return fetch('/api' + path); }`,
        expected: [],
      },
      {
        shape: 'a URL builder with different branch returns',
        source: `function build(path) { if (runtime()) return '/private' + path; return '/api' + path; }
          function request(path) { return fetch(build(path)); }`,
        expected: [],
      },
      {
        shape: 'a recursive URL builder',
        source: `function build(path) { return build(path); }
          function request(path) { return fetch(build(path)); }`,
        expected: [],
      },
      {
        shape: 'an async URL builder returning a Promise',
        source: `async function build(path) { return '/api' + path; }
          function request(path) { return fetch(build(path)); }`,
        expected: [],
      },
      {
        shape: 'a generator URL builder returning an iterator',
        source: `function* build(path) { return '/api' + path; }
          function request(path) { return fetch(build(path)); }`,
        expected: [],
      },
    ])('resolves the actual URL for $shape (#2858)', ({ source, expected }) => {
      const { root, context: wrapper } = context(`${source}\nrequest('/models');`);
      const definitions = root.namedChildren.flatMap((node) => {
        const facts = wrapper.facts(node);
        const name = node.childForFieldName('name')?.text;
        return facts && name ? [{ ...facts, filePath: 'consumer.ts', functionName: name }] : [];
      });
      const index = buildFetchWrapperIndex(definitions);
      const call = wrapper.calls().find((candidate) => candidate.functionName === 'request')!;
      expect(index.urlsForCall(call).map(normalizeFetchURL)).toEqual(expected);
    });

    it('preserves exact callee names and source lines, including comments and optional calls', () => {
      expect(
        extract(
          `
        doRequest('/api/one');
        client /* receiver */ . doRequest(/* url */ '/api/two');
        api.client?.doRequest?.('/api/three');
        cafédoRequest('/api/four');
      `,
          10,
        ),
      ).toEqual([
        {
          filePath: 'consumer.ts',
          functionName: 'doRequest',
          fetchURL: '/api/one',
          lineNumber: 12,
          target: { kind: 'unresolved' },
        },
        {
          filePath: 'consumer.ts',
          functionName: 'client.doRequest',
          fetchURL: '/api/two',
          lineNumber: 13,
          target: { kind: 'member' },
        },
        {
          filePath: 'consumer.ts',
          functionName: 'api.client.doRequest',
          fetchURL: '/api/three',
          lineNumber: 14,
          target: { kind: 'member' },
        },
        {
          filePath: 'consumer.ts',
          functionName: 'cafédoRequest',
          fetchURL: '/api/four',
          lineNumber: 15,
          target: { kind: 'unresolved' },
        },
      ]);
    });

    // A wrapper calls fetch itself, through a global object or a local alias;
    // it carries a URL when its first parameter reaches fetch's URL argument,
    // directly or through a callee it forwards that parameter to (#1852, #3488).
    it.each([
      {
        shape: 'a direct call nested deeper than the old depth limit',
        source: `async function load(url) {
          try { for (;;) { if (url) { const r = await fetch(url); return r; } } } catch (e) {}
        }`,
        facts: {
          seed: true,
          forwardsUrl: true,
          forwardsTo: [{ callee: 'fetch', kind: 'unresolved' }],
        },
      },
      {
        shape: 'an exported arrow const',
        source: 'export const load = async (url) => { const r = await fetch(url); return r; };',
        facts: {
          seed: true,
          forwardsUrl: true,
          forwardsTo: [{ callee: 'fetch', kind: 'unresolved' }],
        },
      },
      {
        shape: 'an alias of globalThis.fetch',
        source: `async function resilientFetch(input, init, opts = {}) {
          const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
          try { return await fetchImpl(input, init); } catch (e) { throw e; }
        }`,
        facts: {
          seed: true,
          forwardsUrl: true,
          forwardsTo: [{ callee: 'fetchImpl', kind: 'binding' }],
        },
      },
      {
        shape: 'window.fetch',
        source: 'function load(url = "/x") { return window.fetch(url); }',
        facts: {
          seed: true,
          forwardsUrl: true,
          forwardsTo: [{ callee: 'window.fetch', kind: 'member' }],
        },
      },
      {
        shape: 'a URL built from the parameter',
        source: 'function apiFetch(path, opts) { return fetch(`${API_BASE}${path}`, opts); }',
        facts: { seed: true, forwardsUrl: true, forwardsTo: [] },
      },
      {
        shape: 'a fetch whose URL is not the parameter',
        source: `function track(event) {
          return fetch('/api/events', { method: 'POST', body: JSON.stringify(event) });
        }`,
        facts: {
          seed: true,
          forwardsUrl: false,
          forwardsTo: [{ callee: 'JSON.stringify', kind: 'member' }],
        },
      },
      {
        shape: 'a forwarder to another wrapper',
        source: `const fetchWithTimeout = async (url, init = {}) => {
          try { return await resilientFetch(url, { ...init }, {}); } finally { done(); }
        };`,
        facts: {
          seed: false,
          forwardsUrl: false,
          forwardsTo: [{ callee: 'resilientFetch', kind: 'unresolved' }],
        },
      },
      {
        shape: 'fetch named only in a string, a comment, and an unrelated property',
        source: `function goTo(path) {
          const fail = (e) => console.warn('Failed to fetch route data', e);
          /* we never fetch here */
          const mode = node.kind === 'fetch';
          try { history.pushState(null, '', path); } catch (e) { fail(e); }
        }`,
        facts: { seed: false, forwardsUrl: false, forwardsTo: [] },
      },
      {
        shape: 'an unrelated function',
        source: 'function log(message) { console.log("x", message); }',
        facts: { seed: false, forwardsUrl: false, forwardsTo: [] },
      },
      {
        shape: 'an alias declared only in a nested helper',
        source: `function run(url, fetchImpl) {
          function setup() { const fetchImpl = globalThis.fetch; return fetchImpl; }
          return fetchImpl(url);
        }`,
        facts: {
          seed: false,
          forwardsUrl: false,
          forwardsTo: [{ callee: 'fetchImpl', kind: 'binding' }],
        },
      },
      {
        shape: 'a nested helper that never runs, beside a retry callback that does',
        source: `function defer(url) {
          const later = () => resilientFetch(url);
          return withRetry(() => send(url));
        }`,
        facts: {
          seed: false,
          forwardsUrl: false,
          forwardsTo: [{ callee: 'send', kind: 'unresolved' }],
        },
      },
      {
        shape: 'an alias shadowed by a nested function parameter',
        source: `function track(event) {
          const fetchImpl = globalThis.fetch;
          function send(fetchImpl) { return fetchImpl(event); }
          return send(log);
        }`,
        facts: {
          seed: false,
          forwardsUrl: false,
          forwardsTo: [{ callee: 'fetchImpl', kind: 'binding' }],
        },
      },
      {
        shape: 'an alias shadowed by a block-scoped redeclaration',
        source: `function f() {
          const fetchImpl = globalThis.fetch;
          { const fetchImpl = other; fetchImpl('/api/x'); }
        }`,
        facts: { seed: false, forwardsUrl: false, forwardsTo: [] },
      },
      {
        shape: 'a window parameter rather than the browser global',
        source: 'function wrapper(url, window) { return window.fetch(url); }',
        facts: {
          seed: false,
          forwardsUrl: false,
          forwardsTo: [{ callee: 'window.fetch', kind: 'member' }],
        },
      },
      {
        shape: 'an uncalled nested function declaration',
        source: `function setup(path) {
          function helper() { return fetch('/api/x'); }
          return register(path);
        }`,
        facts: {
          seed: false,
          forwardsUrl: false,
          forwardsTo: [{ callee: 'register', kind: 'unresolved' }],
        },
      },
      {
        shape: 'a parameter shadowed by a local',
        source: `function fixed(url) { { const url = '/health'; return fetch(url); } }`,
        facts: { seed: true, forwardsUrl: false, forwardsTo: [] },
      },
      {
        shape: 'a forwarder to a relative named import',
        source: `import { request as send } from '../desktop/ipc.js';
        export function openPage(path) { return send(path); }`,
        facts: {
          seed: false,
          forwardsUrl: false,
          forwardsTo: [{ callee: 'send', kind: 'import' }],
        },
      },
      {
        shape: 'a forwarder to a same-file function',
        source: `function request(channel) { return ipc.invoke(channel); }
        export const openPage = (path) => request(path);`,
        facts: {
          seed: false,
          forwardsUrl: false,
          forwardsTo: [{ callee: 'request', kind: 'binding' }],
        },
      },
    ])('reads wrapper facts from $shape', ({ source, facts }) => {
      const { root, context: wrapper } = context(source, 'src/web/client.ts');
      const actual = wrapper.facts(root.namedChildren[root.namedChildren.length - 1]);
      // Exact facts, with each forwarded callee's target kind.
      expect({
        seed: actual?.seed,
        forwardsUrl: actual?.forwardsUrl,
        forwardsTo: actual?.forwardsTo.map(({ callee, target }) => ({ callee, kind: target.kind })),
      }).toEqual(facts);
    });

    it('records lexical and import identity of bare callees', () => {
      const source = `import { request as send } from './api';
        send('/api/one'); local('/api/two'); api.request('/api/three'); function local(u) {}`;
      const calls = context(source, 'src/web/page.ts').context.calls();
      expect(calls.map(({ functionName, target }) => ({ functionName, target }))).toEqual([
        {
          functionName: 'send',
          target: { kind: 'import', specifier: './api', importedName: 'request' },
        },
        { functionName: 'local', target: { kind: 'binding', bindingId: expect.any(String) } },
        { functionName: 'api.request', target: { kind: 'member' } },
      ]);
    });

    it('preserves configured instance and inherited wrappers', () => {
      expect(
        extract(`class Client extends Base {
        load() {
          this.doRequest('/api/one');
          this.http.doRequest('/api/two');
          super.doRequest('/api/three');
        }
      }`).map((call) => call.functionName),
      ).toEqual(['this.doRequest', 'this.http.doRequest', 'super.doRequest']);
    });

    it('keeps template substitutions for route normalization', () => {
      expect(extract('doRequest(`/api/users/${id}`)')).toMatchObject([
        { functionName: 'doRequest', fetchURL: '/api/users/${id}' },
      ]);
    });

    it('keeps a base-URL template whose remainder is a path (#3488)', () => {
      expect(extract('doRequest(`${base}/api/users/${id}`)')).toMatchObject([
        { functionName: 'doRequest', fetchURL: '${base}/api/users/${id}' },
      ]);
    });

    it.each([
      '// doRequest("/api/things")',
      '/* doRequest("/api/things") */',
      '`doRequest("/api/things")`',
      'doRequest("/api/things" + suffix)',
      'doRequest(url, "/api/things")',
      'doRequest(...["/api/things"])',
      'new doRequest("/api/things")',
      'client["doRequest"]("/api/things")',
      'getClient().doRequest("/api/things")',
      'doRequest("https://example.com/api/things")',
      'doRequest(`${base}api/things`)',
      'doRequest(`${scheme}://${host}/api/things`)',
    ])('does not invent a candidate for %s', (source) => {
      expect(extract(source)).toEqual([]);
    });
  });
}

// Type arguments exist only in the TypeScript grammars.
for (const [name, grammar, provider] of grammars.slice(1)) {
  describe(`${name} typed fetch wrapper calls`, () => {
    const { extract } = harness(grammar, provider);

    it.each([
      'Array<{ result: Promise<string> }>',
      '(value: string) => Promise<{ kind: "thing" }>',
      '{ compare: ">"; callback: () => void }',
      '[string, number]',
      'T extends string ? Array<T> : never',
    ])('accepts type arguments %s', (types) => {
      expect(extract(`doRequest<${types}>('/api/things')`)).toMatchObject([
        { functionName: 'doRequest', fetchURL: '/api/things' },
      ]);
    });

    it('handles awaited generic calls in the installed grammar', () => {
      expect(
        extract(`async function load() {
        await /* request */ doRequest<string[]>('/api/one');
        await client.doRequest<() => void>('/api/two');
      }`).map((call) => [call.functionName, call.fetchURL]),
      ).toEqual([
        ['doRequest', '/api/one'],
        ['client.doRequest', '/api/two'],
      ]);
    });

    it('captures only the actual callee after generic references', () => {
      expect(
        extract(`
        const typed = doRequest<string>;
        const load: typeof doRequest<string> = makeLoader<string>('/api/things');
      `).map((call) => call.functionName),
      ).toEqual(['makeLoader']);
    });
  });
}
