import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import { extractFetchWrapperCalls } from '../../src/core/ingestion/route-extractors/fetch-wrapper.js';

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
