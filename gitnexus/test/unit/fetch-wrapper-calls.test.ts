import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import {
  extractFetchWrapperCalls,
  fetchWrapperFacts,
} from '../../src/core/ingestion/route-extractors/fetch-wrapper.js';

for (const [name, grammar] of [
  ['JavaScript', JavaScript],
  ['TypeScript', TypeScript.typescript],
  ['TSX', TypeScript.tsx],
] as const) {
  describe(`${name} fetch wrapper calls`, () => {
    const parser = new Parser();
    parser.setLanguage(grammar);
    const extract = (source: string, lineOffset = 0) =>
      extractFetchWrapperCalls(parser.parse(source), 'consumer.ts', lineOffset);

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
        },
        {
          filePath: 'consumer.ts',
          functionName: 'client.doRequest',
          fetchURL: '/api/two',
          lineNumber: 13,
        },
        {
          filePath: 'consumer.ts',
          functionName: 'api.client.doRequest',
          fetchURL: '/api/three',
          lineNumber: 14,
        },
        {
          filePath: 'consumer.ts',
          functionName: 'cafédoRequest',
          fetchURL: '/api/four',
          lineNumber: 15,
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
        facts: { seed: true, forwardsUrl: true, forwardsTo: [{ callee: 'fetch', module: null }] },
      },
      {
        shape: 'an exported arrow const',
        source: 'export const load = async (url) => { const r = await fetch(url); return r; };',
        facts: { seed: true, forwardsUrl: true, forwardsTo: [{ callee: 'fetch', module: null }] },
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
          forwardsTo: [{ callee: 'fetchImpl', module: null }],
        },
      },
      {
        shape: 'window.fetch',
        source: 'function load(url = "/x") { return window.fetch(url); }',
        facts: {
          seed: true,
          forwardsUrl: true,
          forwardsTo: [{ callee: 'window.fetch', module: null }],
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
          forwardsTo: [{ callee: 'JSON.stringify', module: null }],
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
          forwardsTo: [{ callee: 'resilientFetch', module: null }],
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
          forwardsTo: [{ callee: 'fetchImpl', module: null }],
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
          forwardsTo: [{ callee: 'request', module: 'src/desktop/ipc' }],
        },
      },
      {
        shape: 'a forwarder to a same-file function',
        source: `function request(channel) { return ipc.invoke(channel); }
        export const openPage = (path) => request(path);`,
        facts: {
          seed: false,
          forwardsUrl: false,
          forwardsTo: [{ callee: 'request', module: 'src/web/client' }],
        },
      },
    ])('reads wrapper facts from $shape', ({ source, facts }) => {
      const root = parser.parse(source).rootNode;
      expect(fetchWrapperFacts(root.namedChildren.at(-1)!, 'src/web/client.ts')).toEqual(facts);
    });

    it('records the module declaring a bare callee', () => {
      expect(
        extractFetchWrapperCalls(
          parser.parse(`import { request as send } from './api';
          send('/api/one');
          local('/api/two');
          api.request('/api/three');
          function local(u) {}`),
          'src/web/page.ts',
          0,
        ).map(({ functionName, module }) => ({ functionName, module })),
      ).toEqual([
        { functionName: 'request', module: 'src/web/api' },
        { functionName: 'local', module: 'src/web/page' },
        { functionName: 'api.request', module: undefined },
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

    if (name !== 'JavaScript') {
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
    }
  });
}
