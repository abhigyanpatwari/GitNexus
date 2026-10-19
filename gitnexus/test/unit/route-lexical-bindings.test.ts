import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import JavaScript from 'tree-sitter-javascript';
import {
  typescriptProvider,
  javascriptProvider,
} from '../../src/core/ingestion/languages/typescript.js';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';
import {
  createLexicalBindings,
  patternBindingNames,
} from '../../src/core/ingestion/route-extractors/lexical-bindings.js';

function analyze(source: string, javascript = false, lineOffset = 0) {
  const parser = new Parser();
  parser.setLanguage(javascript ? JavaScript : TypeScript.typescript);
  const tree = parser.parse(source);
  const fullSource = '\n'.repeat(lineOffset) + source;
  const parsed = extractParsedFile(
    javascript ? javascriptProvider : typescriptProvider,
    fullSource,
    javascript ? 'source.js' : 'source.ts',
    undefined,
    lineOffset ? parser.parse(fullSource) : tree,
  );
  expect(parsed).toBeDefined();
  return {
    root: tree.rootNode,
    bindings: createLexicalBindings(parsed!, lineOffset, tree.rootNode),
  };
}

describe.each([false, true])('HTTP lexical bindings (JavaScript: %s)', (javascript) => {
  it.each([
    ['parameter default', 'app = fallback', 'var app;', 'app', true],
    ['another parameter default', 'app, other = 1', 'var app;', 'app', true],
    ['nested object default', 'app, { nested: { value = 1 } }', 'var app;', 'app', true],
    ['nested array default', 'app, [value = 1]', 'var app;', 'app', true],
    ['computed pattern key', 'app, { [key]: value }', 'var app;', 'app', true],
    ['referenced computed key', '{ [app]: value }', 'var app;', 'app', true],
    [
      'default closure reference',
      'send = () => fetch(url)',
      'var fetch = replacement;',
      'fetch',
      true,
    ],
    ['body function reference', 'send = () => fetch(url)', 'function fetch() {}', 'fetch', true],
    [
      'loop var declaration',
      'send = () => fetch(url)',
      'for (var fetch of values) {}',
      'fetch',
      true,
    ],
    ['empty pattern default', '{} = globalThis.fetch(url)', 'var globalThis;', 'globalThis', true],
    ['rest alone', 'app, ...rest', 'var app;', 'app', false],
    ['nested function body', 'app, other = 1', 'function nested() { var app; }', 'app', false],
    [
      'nested method body',
      'app, other = 1',
      'const object = { method() { var app; } };',
      'app',
      false,
    ],
    ['property name', 'send = () => ({ fetch: 1 })', 'var fetch;', 'fetch', false],
    ['default closure parameter', 'send = (fetch) => 1', 'var fetch;', 'fetch', false],
    [
      'default closure parameter reference',
      'url, fallback = (send) => send',
      'var send = globalThis.fetch;',
      'send',
      false,
    ],
    ['bound property name', '{ fetch: other = 1 }', 'var fetch;', 'fetch', false],
  ])('marks only collapsed environments: %s', (_shape, parameters, body, name, expected) => {
    const { root, bindings } = analyze(
      `function load(${parameters}) { ${body} ${name}; }`,
      javascript,
    );
    const read = root
      .descendantsOfType('identifier')
      .filter((node) => node.text === name)
      .at(-1)!;
    const id = bindings.bindingId(read);
    expect(id).toBeDefined();
    expect(bindings.ambiguous(id!)).toBe(expected);
  });

  it('shares outer ownership across closures and keeps shadowing and global identity separate', () => {
    const { root, bindings } = analyze(
      `let app = factory();
      function outer() { app = new Map(); app; }
      function shadow(app) { app; fetch('/global'); }
      function local(fetch) { fetch('/local'); }`,
      javascript,
    );
    const apps = root.descendantsOfType('identifier').filter((node) => node.text === 'app');
    expect(bindings.bindingId(apps[1])).toBe(bindings.bindingId(apps[0]));
    expect(bindings.bindingId(apps[2], 'app', true)).toBe(bindings.bindingId(apps[0]));
    expect(bindings.bindingId(apps[3])).not.toBe(bindings.bindingId(apps[0]));
    const fetches = root.descendantsOfType('identifier').filter((node) => node.text === 'fetch');
    expect(bindings.isGlobal(fetches[0], 'fetch')).toBe(true);
    expect(bindings.isGlobal(fetches.at(-1)!, 'fetch')).toBe(false);
    const closureWrite = bindings.ownership(apps[2], 'app', true);
    expect(closureWrite?.scope).toBeDefined();
    expect(closureWrite?.scope).toBe(bindings.ownership(apps[0])?.scope);
    expect(bindings.ownership(apps[3])?.scope).not.toBe(closureWrite?.scope);
    // Repeated lookups are memoized per node, name and position mode.
    expect(bindings.ownership(apps[2], 'app', true)).toBe(closureWrite);
  });

  it('preserves TDZ barriers and offset-adjusted lookups', () => {
    const { root, bindings } = analyze('app; let app = factory(); app;', javascript, 12);
    const apps = root.descendantsOfType('identifier').filter((node) => node.text === 'app');
    expect(bindings.bindingId(apps[0], 'app', true)).toBeUndefined();
    expect(bindings.bindingId(apps[2], 'app', true)).toBe(bindings.bindingId(apps[1]));
    expect(bindings.ownership(apps[2])?.scope).toBeDefined();
  });

  it('does not mistake destructuring keys or default expressions for bound names', () => {
    const { root } = analyze(
      'function f({ key: value = fallback, [computed]: alias, short = rhs }, ...rest) {}',
      javascript,
    );
    const parameters = root.descendantsOfType('formal_parameters')[0];
    expect(patternBindingNames(parameters).map((node) => node.text)).toEqual([
      'value',
      'alias',
      'short',
      'rest',
    ]);
  });
});
