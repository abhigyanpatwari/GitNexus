import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';
import { getProvider } from '../../src/core/ingestion/languages/index.js';
import { SupportedLanguages } from 'gitnexus-shared';

const HTTP_CLIENT_RECEIVERS = new Set([
  'axios',
  'request',
  'fetch',
  'http',
  'https',
  'got',
  'ky',
  'superagent',
  'needle',
  'undici',
  'apiclient',
  'client',
  'httpclient',
  'api',
  '$http',
  'session',
  'httpservice',
  'conn',
]);

function extractReceiverText(callNode: SyntaxNode): string {
  const funcNode = callNode.childForFieldName?.('function') ?? callNode.children?.[0];
  let receiverNode = funcNode?.childForFieldName?.('object') ?? funcNode?.children?.[0];
  while (receiverNode?.type === 'member_expression' || receiverNode?.type === 'call_expression') {
    if (receiverNode.type === 'member_expression') {
      const p = receiverNode.childForFieldName?.('property');
      if (p) {
        receiverNode = p;
      } else {
        break;
      }
    } else {
      const inner = receiverNode.childForFieldName?.('function') ?? receiverNode.children?.[0];
      if (inner && inner !== receiverNode) {
        receiverNode = inner;
      } else {
        break;
      }
    }
  }
  return receiverNode?.text?.toLowerCase() ?? '';
}

function extractExpressRouteReceivers(parser: Parser, code: string) {
  const provider = getProvider(SupportedLanguages.TypeScript);
  const tree = parser.parse(code);
  const query = new Parser.Query(parser.getLanguage(), provider.treeSitterQueries!);
  const results: Array<{ method: string; path: string; receiverText: string }> = [];
  for (const match of query.matches(tree.rootNode)) {
    const cm: Record<string, SyntaxNode> = {};
    for (const c of match.captures) cm[c.name] = c.node;
    if (cm['express_route'] && cm['express_route.method'] && cm['express_route.path']) {
      results.push({
        method: cm['express_route.method'].text,
        path: cm['express_route.path'].text,
        receiverText: extractReceiverText(cm['express_route']),
      });
    }
  }
  return results;
}

describe('receiver extraction (express_route walk)', () => {
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);

  it('bare identifier: app.get()', () => {
    const r = extractExpressRouteReceivers(parser, 'app.get("/api/users", h);');
    expect(r[0]?.receiverText).toBe('app');
    expect(HTTP_CLIENT_RECEIVERS.has('app')).toBe(false);
  });

  it('bare identifier: axios.get() is HTTP client', () => {
    const r = extractExpressRouteReceivers(parser, 'axios.get("/api/users");');
    expect(r[0]?.receiverText).toBe('axios');
    expect(HTTP_CLIENT_RECEIVERS.has('axios')).toBe(true);
  });

  it('member chain: this.httpService.get()', () => {
    const r = extractExpressRouteReceivers(
      parser,
      'class S { f() { this.httpService.get("/d"); } }',
    );
    const hit = r.find((x) => x.path === '/d');
    expect(hit?.receiverText).toBe('httpservice');
    expect(HTTP_CLIENT_RECEIVERS.has('httpservice')).toBe(true);
  });

  it('member chain: this.client.post()', () => {
    const r = extractExpressRouteReceivers(parser, 'class A { s() { this.client.post("/x"); } }');
    const hit = r.find((x) => x.path === '/x');
    expect(hit?.receiverText).toBe('client');
    expect(HTTP_CLIENT_RECEIVERS.has('client')).toBe(true);
  });

  it('call_expression: getClient().get()', () => {
    const r = extractExpressRouteReceivers(parser, 'getClient().get("/api/data");');
    expect(r.find((x) => x.path === '/api/data')?.receiverText).toBe('getclient');
  });

  it('call_expression: createHttpClient().post()', () => {
    const r = extractExpressRouteReceivers(parser, 'createHttpClient().post("/s");');
    expect(r.find((x) => x.path === '/s')?.receiverText).toBe('createhttpclient');
  });

  it('mixed: factory().api.get()', () => {
    const r = extractExpressRouteReceivers(parser, 'factory().api.get("/items");');
    expect(r.find((x) => x.path === '/items')?.receiverText).toBe('api');
    expect(HTTP_CLIENT_RECEIVERS.has('api')).toBe(true);
  });

  it('router.post() is NOT an HTTP client', () => {
    const r = extractExpressRouteReceivers(parser, 'router.post("/api/items", h);');
    expect(r[0]?.receiverText).toBe('router');
    expect(HTTP_CLIENT_RECEIVERS.has('router')).toBe(false);
  });
});
