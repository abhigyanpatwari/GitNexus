import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import { createFetchWrapperContext } from '../../src/core/ingestion/route-extractors/fetch-wrapper.js';

import { buildFetchWrapperIndex } from '../../src/core/ingestion/route-extractors/fetch-wrapper-index.js';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';
import {
  typescriptProvider,
  javascriptProvider,
} from '../../src/core/ingestion/languages/typescript.js';

for (const [language, grammar] of [
  ['JavaScript', JavaScript],
  ['TypeScript', TypeScript.typescript],
  ['TSX', TypeScript.tsx],
] as const) {
  describe(`${language} wrapper provenance`, () => {
    const parser = new Parser();
    parser.setLanguage(grammar);
    const analyze = (source: string, lineOffset = 0) => {
      const tree = parser.parse(source);
      const fullSource = '\n'.repeat(lineOffset) + source;
      const parsedFile = extractParsedFile(
        language === 'JavaScript' ? javascriptProvider : typescriptProvider,
        fullSource,
        language === 'TSX' ? 'source.tsx' : 'source.ts',
        undefined,
        parser.parse(fullSource),
      )!;
      return { tree, parsedFile, context: createFetchWrapperContext(tree, parsedFile, lineOffset) };
    };
    it.each([
      ['injected fetch', 'function load(url, fetch) { fetch(url); }', false, false],
      [
        'platform default',
        'function load(url, fetch = globalThis.fetch) { fetch(url); }',
        true,
        true,
      ],
      ['self default', 'function load(url, fetch = fetch) { fetch(url); }', false, false],
      [
        'shadowed default root',
        'function load(url, globalThis, fetch = globalThis.fetch) { fetch(url); }',
        false,
        false,
      ],
      [
        'sibling URL shadow',
        'function load(url) { { const url = "fixed"; } fetch(url); }',
        true,
        true,
      ],
      [
        'sibling platform shadow',
        'function load(url) { { const globalThis = {}; } globalThis.fetch(url); }',
        true,
        true,
      ],
      [
        'sibling alias shadow',
        'function load(url) { const send = globalThis.fetch; { const send = other; } send(url); }',
        true,
        true,
      ],
      [
        'alias reassignment',
        'function load(url) { let send = globalThis.fetch; send = other; send(url); }',
        false,
        false,
      ],
      ['URL reassignment', 'function load(url) { url = "fixed"; fetch(url); }', true, false],
      [
        'parenthesized alias reassignment',
        'function load(url) { let send = globalThis.fetch; (send) = other; send(url); }',
        false,
        false,
      ],
      [
        'parenthesized URL reassignment',
        'function load(url) { (url) = "fixed"; fetch(url); }',
        true,
        false,
      ],
      [
        'unused recursive helper',
        'function load(url) { function helper() { fetch(url); helper(); } }',
        false,
        false,
      ],
      [
        'unused mutual recursion',
        'function load(url) { function a() { b(); } function b() { fetch(url); a(); } }',
        false,
        false,
      ],
      [
        'rooted recursion',
        'function load(url) { function a() { b(); } function b() { fetch(url); a(); } a(); }',
        true,
        true,
      ],
      ['IIFE', 'function load(url) { (() => fetch(url))(); }', true, true],
      ['inline callback', 'function load(url) { retry(() => fetch(url)); }', true, true],
      ['escaping anonymous', 'function load(url) { return () => fetch(url); }', true, true],
      [
        'stored anonymous property',
        'function load(url) { object.callback = () => fetch(url); }',
        true,
        true,
      ],
      ['unused arrow', 'function load(url) { const later = () => fetch(url); }', false, false],
      [
        'unused wrapped arrow',
        'function load(url) { const later = (() => fetch(url)); }',
        false,
        false,
      ],
      [
        'referenced arrow',
        'function load(url) { const later = () => fetch(url); return later; }',
        true,
        true,
      ],
      [
        'class static block',
        'function load(url) { class C { static { fetch(url); } } }',
        true,
        true,
      ],
      [
        'class static field',
        'function load(url) { class C { static x = fetch(url); } }',
        true,
        true,
      ],
      ['class computed key', 'function load(url) { class C { [fetch(url)]() {} } }', true, true],
      [
        'class heritage',
        'function load(url) { class C extends factory(fetch(url)) {} }',
        true,
        true,
      ],
      [
        'deferred method',
        'function load(url) { class C { method() { fetch(url); } } }',
        false,
        false,
      ],
      [
        'deferred instance field',
        'function load(url) { class C { x = fetch(url); } }',
        false,
        false,
      ],
      [
        'referenced class',
        'function load(url) { class C { method() { fetch(url); } } return new C(); }',
        true,
        true,
      ],
      [
        'class expression static',
        'function load(url) { const C = class { static x = fetch(url); }; }',
        true,
        true,
      ],
      [
        'class expression deferred',
        'function load(url) { const C = class { x = fetch(url); }; }',
        false,
        false,
      ],
      [
        'referenced class expression',
        'function load(url) { const C = class { x = fetch(url); }; return C; }',
        true,
        true,
      ],
      [
        'collapsed parameter environments',
        'function load(url, send = () => fetch(url)) { var fetch = () => 0; return send(); }',
        false,
        false,
      ],
    ])('%s', (_shape, source, seed, forwardsUrl) => {
      const tree = parser.parse(source);
      const parsedFile = extractParsedFile(
        language === 'JavaScript' ? javascriptProvider : typescriptProvider,
        source,
        language === 'TSX' ? 'source.tsx' : 'source.ts',
        undefined,
        tree,
      )!;
      expect(
        createFetchWrapperContext(tree, parsedFile).facts(tree.rootNode.firstNamedChild!),
      ).toMatchObject({ seed, forwardsUrl });
    });

    it.each([
      ['parameter', 'function load(request) { request("/api/x"); }', 'binding'],
      ['local nonwrapper', 'const request = custom; request("/api/x");', 'binding'],
      ['future local', 'request("/api/x"); const request = custom;', 'blocked'],
      [
        'mutated wrapper',
        'function request(url) { return fetch(url); } request = custom; request("/api/x");',
        'blocked',
      ],
      [
        'mutated import',
        'import { request } from "./api"; request = custom; request("/api/x");',
        'blocked',
      ],
      [
        'namespace member behavior',
        'import * as api from "./api"; api.request = custom; api.request("/api/x");',
        'member',
      ],
    ])('retains contradictory target evidence: %s', (_shape, source, kind) => {
      const { context } = analyze(source);
      expect(context.calls()).toMatchObject([{ target: { kind } }]);
    });

    it('records bare import targets while preserving member-call behavior', () => {
      const { context } = analyze(
        'import request from "@workspace/api"; import { load as send } from "@/service"; import * as api from "./client.js"; request("/a"); send("/b"); api.load("/c");',
      );
      expect(context.calls().map((call) => call.target)).toEqual([
        { kind: 'import', specifier: '@workspace/api', importedName: 'default' },
        { kind: 'import', specifier: '@/service', importedName: 'load' },
        { kind: 'member' },
      ]);
    });

    it('keeps negative definitions, exports and declaration identities across serialization', () => {
      const { tree, context } = analyze(
        'export function request(url) { return fetch(url); } export { request as send }; export default request; function outer() { function request(value) { return value; } }',
      );
      const functions = tree.rootNode.descendantsOfType('function_declaration');
      const facts = functions.map((fn) => context.facts(fn)!);
      expect(facts).toHaveLength(3);
      expect(facts[0]).toMatchObject({
        moduleScope: true,
        exportedNames: ['request', 'send', 'default'],
        seed: true,
      });
      expect(facts[2]).toMatchObject({
        moduleScope: false,
        exportedNames: [],
        seed: false,
        forwardsUrl: false,
      });
      expect(facts[0].bindingId).not.toBe(facts[2].bindingId);
      expect(new Set(facts.map((fact) => fact.definitionId)).size).toBe(3);
      expect(JSON.parse(JSON.stringify(facts))).toEqual(facts);
    });

    it.each([
      [
        'after a non-callable initializer',
        'const base = 0, request = (url) => fetch(url);',
        'request',
        true,
      ],
      [
        'after another callable',
        'const first = (value) => value, request = (url) => fetch(url);',
        'request',
        true,
      ],
      [
        'for the first of several callables',
        'const first = (value) => value, request = (url) => fetch(url);',
        'first',
        false,
      ],
    ])('selects the captured declarator %s', (_shape, source, name, wraps) => {
      const { tree, context } = analyze(source);
      const declaration = tree.rootNode.firstNamedChild!;
      const nameNode = declaration
        .descendantsOfType('identifier')
        .find((node) => node.text === name)!;
      const facts = context.facts(declaration, nameNode);
      expect(facts).toMatchObject({ seed: wraps, forwardsUrl: wraps });
      expect(facts?.bindingId).toBe(context.bindings.bindingId(nameNode));
    });

    it.each([
      ['a hook callback', 'const load = useCallback((url) => fetch(url), []); load("/api/x");'],
      ['a curried wrapper', 'const load = wrap(other((url) => fetch(url))); load("/api/x");'],
    ])('follows the callable inside %s', (_shape, source) => {
      const { tree, context } = analyze(source);
      const declaration = tree.rootNode.firstNamedChild!;
      const nameNode = declaration.descendantsOfType('identifier')[0];
      const facts = context.facts(declaration, nameNode);
      expect(facts).toMatchObject({ seed: true, forwardsUrl: true });
      expect(facts?.bindingId).toBe(context.bindings.bindingId(nameNode));
      expect(context.calls()).toMatchObject([
        { target: { kind: 'binding', bindingId: facts?.bindingId } },
      ]);
    });

    it.each([
      ['an object-literal key', 'const api = { request: (url) => request(url) };', 'pair'],
      ['a class method name', 'class Api { request(url) { return url; } }', 'method_definition'],
    ])('keeps %s out of lexical binding identity', (_shape, other, nodeType) => {
      const { tree, parsedFile, context } = analyze(
        `export function request(url) { return fetch(url); }\n${other}\nrequest("/api/x");`,
      );
      const wrapper = tree.rootNode.descendantsOfType('function_declaration')[0];
      const owner = tree.rootNode.descendantsOfType(nodeType)[0];
      const key = owner.childForFieldName('key') ?? owner.childForFieldName('name')!;
      const facts = [context.facts(wrapper)!, context.facts(owner, key)!];
      expect(facts[1]).toMatchObject({ moduleScope: false, exportedNames: [] });
      expect(facts[1].bindingId).toBeUndefined();
      const index = buildFetchWrapperIndex(
        facts.map((fact) => ({ filePath: parsedFile.filePath, functionName: 'request', ...fact })),
      );
      expect(context.calls().map((call) => index.isWrapperCall(call))).toEqual([true]);
    });

    it.each([
      [
        'object, member and nested member forms',
        'function request(url) { return fetch(url); }\nmodule.exports = { request, send: request };\nexports.other = request;\nmodule.exports.third = request;',
        ['request', 'send', 'other', 'third'],
      ],
      [
        'a whole-module export',
        'function request(url) { return fetch(url); }\nmodule.exports = request;',
        ['default'],
      ],
      [
        'a shadowed module object',
        'function request(url) { return fetch(url); }\nfunction install(module) { module.exports = { request }; }',
        [],
      ],
    ])('records CommonJS exports of a declaration: %s', (_shape, source, names) => {
      const { tree, context } = analyze(source);
      expect(context.facts(tree.rootNode.firstNamedChild!)?.exportedNames.sort()).toEqual(
        [...names].sort(),
      );
    });

    // The query captures these wrappers as their assignment, not as the function.
    it.each([
      [
        'an exports member',
        'exports.request = function (url) { return fetch(url); };',
        ['request'],
      ],
      ['a module.exports member', 'module.exports.request = (url) => fetch(url);', ['request']],
      [
        'the whole module',
        'module.exports = async function (url) { return fetch(url); };',
        ['default'],
      ],
    ])('records a wrapper captured as its CommonJS assignment: %s', (_shape, source, names) => {
      const { tree, context } = analyze(source);
      const assignment = tree.rootNode.descendantsOfType('assignment_expression')[0];
      const property = assignment.childForFieldName('left')?.childForFieldName('property');
      expect(context.facts(assignment, property ?? undefined)).toMatchObject({
        moduleScope: true,
        exportedNames: names,
        seed: true,
        forwardsUrl: true,
      });
    });

    it.each([
      [
        'an aliased export reassigned later',
        'function request(url) { return fetch(url); } export { request as send }; request = JSON.stringify;',
        ['send'],
      ],
      [
        'a reassigned let export',
        'export let request = (url) => fetch(url); request = String;',
        ['request'],
      ],
      [
        'a declaration rebound by a var initializer',
        'function request(url) { return fetch(url); } var request = ipc.send;',
        [],
      ],
    ])('keeps a rebound binding from proving a wrapper: %s', (_shape, source, names) => {
      const { tree, context } = analyze(source);
      const [callable] = tree.rootNode.descendantsOfType([
        'function_declaration',
        'arrow_function',
      ]);
      expect(context.facts(callable)).toMatchObject({
        exportedNames: names,
        seed: false,
        forwardsUrl: false,
        forwardsTo: [],
      });
    });

    it.each([
      [
        'inside recovered syntax',
        'import { request } from "./http";\nfoo(() => { request("/api/a"); }, ',
        { kind: 'import', specifier: './http', importedName: 'request' },
      ],
      [
        'in an instance field initializer before the declaration',
        'export class Store { data = request("/api/a"); }\nconst request = (url) => fetch(url);',
        { kind: 'binding' },
      ],
      [
        'in a static field initializer before the declaration',
        'export class Store { static data = request("/api/a"); }\nconst request = (url) => fetch(url);',
        { kind: 'blocked' },
      ],
    ])('resolves a call %s', (_shape, source, target) => {
      const { context } = analyze(source);
      expect(context.calls()).toMatchObject([{ fetchURL: '/api/a', target }]);
    });

    it('keys cached facts by the name node as well as the callable', () => {
      const { tree, context } = analyze('function request(url) { return fetch(url); }');
      const fn = tree.rootNode.descendantsOfType('function_declaration')[0];
      const [parameter] = fn.descendantsOfType('identifier').filter((node) => node.text === 'url');
      const byName = context.facts(fn);
      expect(byName?.bindingId).toBeDefined();
      expect(context.facts(fn, parameter)?.bindingId).not.toBe(byName?.bindingId);
      expect(context.facts(fn)).toBe(byName);
    });

    it('records a function defined inline in a CommonJS export object', () => {
      const { tree, context } = analyze('module.exports = { inline: (url) => fetch(url) };');
      const pair = tree.rootNode.descendantsOfType('pair')[0];
      expect(context.facts(pair, pair.childForFieldName('key')!)).toMatchObject({
        moduleScope: true,
        exportedNames: ['inline'],
        seed: true,
      });
    });

    it.each([
      ['a default node-fetch import', 'import fetch from "node-fetch";', 'fetch', true],
      ['a named undici fetch', 'import { fetch as get } from "undici";', 'get', true],
      ['a required cross-fetch module', 'const nf = require("cross-fetch");', 'nf', true],
      [
        'a whatwg-fetch member',
        'import { fetch as polyfill } from "whatwg-fetch";',
        'polyfill',
        true,
      ],
      ['a local module named fetch', 'import fetch from "./local-fetch";', 'fetch', false],
      [
        'another member of a fetch package',
        'import { Headers as fetch } from "node-fetch";',
        'fetch',
        false,
      ],
    ])(
      'treats %s as fetch evidence only for known fetch exports',
      (_shape, header, local, wraps) => {
        const { tree, context } = analyze(
          `${header}\nfunction load(url) { return ${local}(url); }`,
        );
        expect(context.facts(tree.rootNode.lastNamedChild!)).toMatchObject({
          seed: wraps,
          forwardsUrl: wraps,
        });
      },
    );

    it('keeps distinct declarations even when a binding is shared', () => {
      const { tree, context } = analyze(
        'function request(url) { return fetch(url); } function request(url) { return custom(url); }',
      );
      const facts = tree.rootNode.namedChildren.map((fn) => context.facts(fn)!);
      expect(facts[0].bindingId).toBe(facts[1].bindingId);
      expect(facts[0].definitionId).not.toBe(facts[1].definitionId);
    });

    it('retains source offsets and provider context identity', () => {
      const { tree, parsedFile, context } = analyze(
        'export function request(url) { return fetch(url); }\nrequest("/api/x");',
        12,
      );
      const definition = tree.rootNode.firstNamedChild!;
      const provider = language === 'JavaScript' ? javascriptProvider : typescriptProvider;
      const first = provider.extractFetchWrapperFacts!(definition, undefined, parsedFile, 12);
      expect(provider.extractFetchWrapperFacts!(definition, undefined, parsedFile, 12)).toBe(first);
      expect(context.facts(definition)).toEqual(first);
      expect(first!.definitionId).toContain(':13:');
      expect(context.calls()).toMatchObject([
        { lineNumber: 14, target: { kind: 'binding', bindingId: first!.bindingId } },
      ]);
    });

    it('recognizes an anonymous default export', () => {
      const { tree, context } = analyze('export default function (url) { return fetch(url); }');
      expect(context.facts(tree.rootNode.firstNamedChild!)).toMatchObject({
        moduleScope: true,
        exportedNames: ['default'],
        seed: true,
        forwardsUrl: true,
      });
    });
  });
}

it.each(['deep', 'deep-arrow', 'wide'] as const)(
  'keeps native AST traversal bounded for %s helpers',
  (shape) => {
    const count = 128;
    const source = (
      shape !== 'wide'
        ? [
            'function load(url) {',
            ...Array.from({ length: count }, (_, i) =>
              shape === 'deep' ? `function helper${i}() {` : `const helper${i} = () => {`,
            ),
            'return fetch(url);',
            ...Array.from({ length: count }, (_, i) => `}; return helper${count - i - 1}();`),
            '}',
          ]
        : [
            'function load(url) {',
            ...Array.from({ length: count }, (_, i) => `function helper${i}() { fetch(url); }`),
            ...Array.from({ length: count }, (_, i) => `helper${i}();`),
            '}',
          ]
    ).join('\n');
    const parser = new Parser();
    parser.setLanguage(TypeScript.typescript);
    const tree = parser.parse(source);
    const parsedFile = extractParsedFile(typescriptProvider, source, 'nested.ts', undefined, tree)!;
    const functions = tree.rootNode.descendantsOfType(['function_declaration', 'arrow_function']);
    const depths = new Map<number, number>();
    const pending = [{ node: tree.rootNode, depth: 0 }];
    while (pending.length) {
      const { node, depth } = pending.pop()!;
      depths.set(node.id, depth);
      for (const child of node.namedChildren) pending.push({ node: child, depth: depth + 1 });
    }
    let prototype = Object.getPrototypeOf(tree.rootNode);
    while (!Object.hasOwn(prototype, 'parent')) prototype = Object.getPrototypeOf(prototype);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'parent')!;
    const childDescriptor = Object.getOwnPropertyDescriptor(prototype, 'namedChild')!;
    let parentTraversalSteps = 0;
    let childTraversalSteps = 0;
    // tree-sitter's native ts_node_parent descends from the root on every call.
    // Count that depth-weighted work only after parsing and scope extraction.
    Object.defineProperty(prototype, 'parent', {
      ...descriptor,
      get(this: Parser.SyntaxNode) {
        parentTraversalSteps += depths.get(this.id) ?? 0;
        return descriptor.get!.call(this);
      },
    });
    // ts_node__child starts its sibling iterator at zero for every indexed read.
    Object.defineProperty(prototype, 'namedChild', {
      ...childDescriptor,
      value(this: Parser.SyntaxNode, index: number) {
        childTraversalSteps += index + 1;
        return childDescriptor.value.call(this, index);
      },
    });
    try {
      // The instruments must fire before a zero count can mean anything.
      void functions[0].parent;
      void functions[0].namedChild(0);
      expect(parentTraversalSteps).toBeGreaterThan(0);
      expect(childTraversalSteps).toBeGreaterThan(0);
      parentTraversalSteps = 0;
      childTraversalSteps = 0;
      const context = createFetchWrapperContext(tree, parsedFile);
      const facts = functions.map((fn) =>
        context.facts(fn, fn.childForFieldName('name') ?? undefined),
      );
      expect(facts.every((fact) => fact?.seed)).toBe(true);
      expect(facts[0]?.forwardsUrl).toBe(true);
      expect(parentTraversalSteps).toBeLessThanOrEqual(32 * count);
      expect(childTraversalSteps).toBeLessThanOrEqual(64 * count);
    } finally {
      Object.defineProperty(prototype, 'parent', descriptor);
      Object.defineProperty(prototype, 'namedChild', childDescriptor);
    }
  },
);

describe.each([
  ['TypeScript', TypeScript.typescript, 'source.ts'],
  ['TSX', TypeScript.tsx, 'source.tsx'],
] as const)('%s-only wrapper syntax', (_language, grammar, filePath) => {
  const analyze = (source: string) => {
    const parser = new Parser();
    parser.setLanguage(grammar);
    const tree = parser.parse(source);
    const parsedFile = extractParsedFile(typescriptProvider, source, filePath, undefined, tree)!;
    return { tree, context: createFetchWrapperContext(tree, parsedFile) };
  };

  it('associates bodyless overload signatures with their implementation', () => {
    const { tree, context } = analyze(
      'export function request(url: string): Promise<Response>;\nexport function request(url: URL): Promise<Response>;\nexport function request(url: any) { return fetch(url); }\nrequest("/api/x");',
    );
    const signatures = tree.rootNode.descendantsOfType('function_signature');
    const implementation = tree.rootNode.descendantsOfType('function_declaration')[0];
    expect(signatures.map((signature) => context.facts(signature))).toEqual([undefined, undefined]);
    const facts = context.facts(implementation)!;
    expect(facts).toMatchObject({ seed: true, forwardsUrl: true, exportedNames: ['request'] });
    expect(context.calls()).toMatchObject([
      { target: { kind: 'binding', bindingId: facts.bindingId } },
    ]);
  });

  it.each([
    [
      'keeps stored asserted callbacks deferred',
      'function load(url) { const later = (() => fetch(url)) as () => unknown; }',
      false,
    ],
    [
      'evaluates supported decorator expressions while deferring methods',
      'function load(url) { @decorate(fetch(url)) class C { @decorate(fetch(url)) method() { return custom(url); } } }',
      true,
    ],
  ])('%s', (_shape, source, wraps) => {
    const { tree, context } = analyze(source);
    expect(context.facts(tree.rootNode.firstNamedChild!)).toMatchObject({
      seed: wraps,
      forwardsUrl: wraps,
    });
  });

  it('keeps a nested overloaded helper reachable through its one implementation', () => {
    const { tree, context } = analyze(
      'function load(url: string) { function helper(u: string): void; function helper(u: any) { fetch(u); } helper(url); }',
    );
    const facts = context.facts(tree.rootNode.firstNamedChild!)!;
    expect(facts.seed).toBe(true);
    expect(facts.forwardsTo).toMatchObject([{ callee: 'helper', target: { kind: 'binding' } }]);
  });

  it.each([
    [
      'an asserted alias write invalidates the alias',
      'function load(url: string) { let send = globalThis.fetch; (send as unknown) = other; send(url); }',
      false,
    ],
    [
      'a non-null asserted alias write invalidates the alias',
      'function load(url: string) { let send = globalThis.fetch; send! = other; send(url); }',
      false,
    ],
  ])('%s', (_shape, source, wraps) => {
    const { tree, context } = analyze(source);
    expect(context.facts(tree.rootNode.firstNamedChild!)).toMatchObject({
      seed: wraps,
      forwardsUrl: wraps,
    });
  });
});

it('invalidates an alias written through an angle-bracket assertion', () => {
  const source =
    'function load(url: string) { let send = globalThis.fetch; (<any>send) = other; send(url); }';
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  const tree = parser.parse(source);
  const parsedFile = extractParsedFile(typescriptProvider, source, 'source.ts', undefined, tree);
  const load = tree.rootNode.descendantsOfType('function_declaration')[0];
  expect(parsedFile && createFetchWrapperContext(tree, parsedFile).facts(load)).toMatchObject({
    seed: false,
    forwardsUrl: false,
  });
});
