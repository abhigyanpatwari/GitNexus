import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import { extractToolDefinitions } from '../../src/core/ingestion/languages/typescript/tool-definitions.js';

const tsParser = new Parser();
tsParser.setLanguage(TypeScript.typescript);
const jsParser = new Parser();
jsParser.setLanguage(JavaScript);

const sdkImport = `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`;
const server = `${sdkImport}\nconst server = new McpServer({ name: 'example', version: '1' });`;
const extract = (source: string, parser = tsParser, filePath = 'src/server.ts', offset = 0) =>
  extractToolDefinitions(parser.parse(source), filePath, offset);
const metadata = (source: string) =>
  extract(source).map(({ toolName, description }) => ({ toolName, description }));

describe('SDK tool registration extraction', () => {
  it.each([
    ['TypeScript', tsParser, 'src/server.ts'],
    ['JavaScript', jsParser, 'src/server.js'],
  ] as const)(
    'extracts modern %s registrations in ordinary server files',
    (_language, parser, filePath) => {
      expect(
        extract(
          `${server}\nserver.registerTool('search', { description: 'Search files' }, handler);`,
          parser,
          filePath,
          10,
        ),
      ).toEqual([
        {
          filePath,
          toolName: 'search',
          description: 'Search files',
          lineNumber: 13,
          allowFileFallback: false,
        },
      ]);
    },
  );

  it('does not require description or inputSchema, and ignores nested descriptions', () => {
    expect(
      metadata(`${server}
      server.registerTool('empty', {}, () => {});
      server.registerTool('nested', { inputSchema: { description: 'Schema decoy' } }, handler);
      server.registerTool('dynamic-description', { description: getDescription() }, handler);
    `),
    ).toEqual([
      { toolName: 'empty', description: '' },
      { toolName: 'nested', description: '' },
      { toolName: 'dynamic-description', description: '' },
    ]);
  });

  it('recognizes legacy callback-last overloads with descriptions, schemas and annotations', () => {
    expect(
      metadata(`${server}
      server.tool('bare', handler);
      server.tool('described', 'Human description', handler);
      server.tool('schema', { query: z.string().describe('Field decoy') }, handler);
      server.tool('annotated', { readOnlyHint: true }, handler);
      server.tool('full', 'Full description', { query: z.string() }, { readOnlyHint: true }, handler);
    `),
    ).toEqual([
      { toolName: 'bare', description: '' },
      { toolName: 'described', description: 'Human description' },
      { toolName: 'schema', description: '' },
      { toolName: 'annotated', description: '' },
      { toolName: 'full', description: 'Full description' },
    ]);
  });

  it('decodes static names and quoted description keys without distance or property-order limits', () => {
    expect(
      metadata(`${server}
      server.registerTool(\`find\\x2ditems!?\`, {
        inputSchema: { description: 'Nested decoy', example: '${'x'.repeat(2000)}' },
        'descr\\u0069ption': 'Line\\nwith \\"quotes\\" and \\u{1F680}',
      }, handler);
      server.tool('legacy\\u002fname', \`Static description\`, handler);
    `),
    ).toEqual([
      { toolName: 'find-items!?', description: 'Line\nwith "quotes" and 🚀' },
      { toolName: 'legacy/name', description: 'Static description' },
    ]);
  });

  it('recognizes SDK aliases, locally constructed instances and directly typed helper parameters', () => {
    expect(
      metadata(`
      import { McpServer as Server } from '@modelcontextprotocol/sdk/server/mcp.js';
      function install(server: Server) { server.registerTool('helper', {}, handler); }
      const add = (server: Server) => server.tool('arrow-helper', handler);
      function start() {
        const local = new Server({ name: 'local', version: '1' });
        local.registerTool('local', {}, handler);
      }
    `),
    ).toEqual([
      { toolName: 'helper', description: '' },
      { toolName: 'arrow-helper', description: '' },
      { toolName: 'local', description: '' },
    ]);
  });

  it('ignores dynamic names, comments, string decoys and unrelated receivers', () => {
    expect(
      metadata(`${server}
      // server.registerTool('comment', { description: 'decoy' }, handler);
      const decoy = "server.tool('string', handler)";
      server.registerTool(runtimeName, {}, handler);
      server.tool(\`dynamic-\${runtimeName}\`, handler);
      server.registerTool('prefix' + suffix, {}, handler);
      unrelated.registerTool('unrelated', {}, handler);
      const alias = server;
      alias.tool('alias', handler);
    `),
    ).toEqual([]);
  });

  it('rejects shadowed SDK names and receivers, including declarations later in the scope', () => {
    expect(
      metadata(`${server}
      function parameter(server) { server.tool('parameter', handler); }
      function constructor(McpServer) {
        const fake = new McpServer();
        fake.tool('constructor', handler);
      }
      {
        server.registerTool('temporal-shadow', {}, handler);
        const server = unrelated;
      }
      function localType() {
        class McpServer {}
        function helper(server: McpServer) { server.tool('type-shadow', handler); }
      }
    `),
    ).toEqual([]);
  });

  it('rejects reassigned receivers and SDK constructors', () => {
    expect(
      metadata(`${sdkImport}
      let changed = new McpServer();
      changed = unrelated;
      changed.tool('changed', handler);
      const instance = new McpServer();
      function replace() { McpServer = OtherServer; }
      instance.registerTool('constructor-mutated', {}, handler);
    `),
    ).toEqual([]);
  });

  it('uses decoded type-only imports for helper parameters, but not construction', () => {
    expect(
      metadata(`
      import type { McpServer as Server } from '@modelcontextprotocol/\\u0073dk/server/mcp.js';
      function install(server: Server) { server.tool('typed', handler); }
      const fake = new Server();
      fake.tool('type-only-constructor', handler);
    `),
    ).toEqual([{ toolName: 'typed', description: '' }]);
  });

  it.each(['before', 'after'])('allows SDK lifecycle configuration %s registration', (when) => {
    const configure = `server.server.oninitialized = () => {}; server.server.onerror = () => {};`;
    const registration = `server.registerTool('visible', {}, handler);`;
    expect(
      metadata(
        `${server}\n${when === 'before' ? configure + registration : registration + configure}`,
      ),
    ).toEqual([{ toolName: 'visible', description: '' }]);
  });

  it.each([
    [
      'different package',
      `import { McpServer } from 'unrelated'; const server = new McpServer(); server.tool('fake', h);`,
    ],
    [
      'destructured parameter',
      `${server} function install({ server }) { server.tool('fake', h); }`,
    ],
    ['destructured local', `${server} { const { other: server } = obj; server.tool('fake', h); }`],
    ['catch parameter', `${server} try {} catch (server) { server.tool('fake', h); }`],
    ['loop binding', `${server} for (const server of other) { server.tool('fake', h); }`],
    [
      'hoisted var',
      `${server} function install() { server.tool('fake', h); { var server = other; } }`,
    ],
    [
      'generic type',
      `${sdkImport} function install<McpServer>(server: McpServer) { server.tool('fake', h); }`,
    ],
    [
      'named class expression',
      `${sdkImport} const Other = class McpServer { install() { const server = new McpServer(); server.tool('fake', h); } };`,
    ],
    ['method write', `${server} server.tool = unrelated; server.tool('fake', h);`],
    ['quoted method write', `${server} server['tool'] = unrelated; server.tool('fake', h);`],
    ['computed method write', `${server} server[method] = unrelated; server.tool('fake', h);`],
    ['method delete', `${server} delete server.registerTool; server.registerTool('fake', {}, h);`],
    ['destructured write', `${server} ({ server } = other); server.tool('fake', h);`],
    [
      'spread arguments',
      `${server} server.registerTool('fake', ...args); server.tool('fake', ...args);`,
    ],
  ])('rejects %s', (_name, source) => {
    expect(metadata(source)).toEqual([]);
  });

  it('keeps evidence outside shadowing scopes and in closures declared before the instance', () => {
    expect(
      metadata(`${sdkImport}
      function install() { server.tool('closure', handler); }
      const server = new McpServer();
      { const server = unrelated; server.tool('decoy', handler); }
      server.registerTool('outer', {}, handler);
    `),
    ).toEqual([
      { toolName: 'closure', description: '' },
      { toolName: 'outer', description: '' },
    ]);
  });

  it('bounds descriptions to top-level properties and respects property overrides', () => {
    expect(
      metadata(`${server}
      server.registerTool('shorthand', { description: 'Kept', title }, handler);
      server.registerTool('spread-after', { description: 'Unproven', ...config }, handler);
      server.registerTool('spread-before', { ...config, description: 'Known' }, handler);
      server.registerTool('last-wins', { description: 'Old', description: 'New' }, handler);
      server.registerTool('comments', /* first */ 'not an object', /* callback */ handler);
    `),
    ).toEqual([
      { toolName: 'shorthand', description: 'Kept' },
      { toolName: 'spread-after', description: '' },
      { toolName: 'spread-before', description: 'Known' },
      { toolName: 'last-wins', description: 'New' },
      { toolName: 'comments', description: '' },
    ]);
  });

  it('resolves hoisted declarations and immutable callable bindings using supplied graph IDs', () => {
    const tree = tsParser.parse(`${server}
      server.tool('declared', declaration);
      function declaration() {}
      const arrow = () => {};
      const expression = function () {};
      server.registerTool('arrow', {}, arrow);
      server.tool('expression', expression);
      server.tool('inline', () => {});
    `);
    const bindings = new Map<number, string>();
    for (const declaration of tree.rootNode.descendantsOfType([
      'function_declaration',
      'variable_declarator',
    ])) {
      const name = declaration.childForFieldName('name')!;
      bindings.set(name.id, `existing-graph-id:${name.text}`);
    }
    expect(
      extractToolDefinitions(tree, 'server.ts', 0, bindings).map((tool) => [
        tool.toolName,
        tool.handlerNodeId,
      ]),
    ).toEqual([
      ['declared', 'existing-graph-id:declaration'],
      ['arrow', 'existing-graph-id:arrow'],
      ['expression', 'existing-graph-id:expression'],
      ['inline', undefined],
    ]);
    expect(
      extractToolDefinitions(tree, 'server.ts').every((tool) => tool.handlerNodeId === undefined),
    ).toBe(true);
  });

  it('uses the nearest callable binding without conflating same-name declarations', () => {
    const tree = tsParser.parse(`${server}
      function handler() {}
      function install() {
        const handler = () => {};
        server.tool('inner', handler);
      }
      server.tool('outer', handler);
    `);
    const outer = tree.rootNode
      .descendantsOfType('function_declaration')[0]
      .childForFieldName('name')!;
    const inner = tree.rootNode
      .descendantsOfType('variable_declarator')
      .find((node) => node.childForFieldName('name')?.text === 'handler')!
      .childForFieldName('name')!;
    const bindings = new Map([
      [outer.id, 'emitted-outer'],
      [inner.id, 'emitted-inner'],
    ]);
    expect(
      extractToolDefinitions(tree, 'server.ts', 0, bindings).map((tool) => [
        tool.toolName,
        tool.handlerNodeId,
      ]),
    ).toEqual([
      ['inner', 'emitted-inner'],
      ['outer', 'emitted-outer'],
    ]);
  });

  it('keeps ambiguous, shadowed, mutable and noncallable handler bindings unresolved', () => {
    const tree = tsParser.parse(`${server}
      import { imported } from './handlers';
      function handler() {}
      function parameter(handler) { server.tool('parameter', handler); }
      { const handler = 42; server.tool('shadowed', handler); }
      const alias = handler;
      server.tool('alias', alias);
      server.tool('imported', imported);
      let mutable = () => {};
      server.tool('mutable', mutable);
      const reassigned = () => {};
      ({ reassigned } = replacements);
      server.tool('reassigned', reassigned);
      function duplicate() {}
      function duplicate() {}
      server.tool('duplicate', duplicate);
      server.tool('before-initialization', later);
      const later = () => {};
    `);
    const bindings = new Map<number, string>();
    // Even graph nodes sharing these names cannot establish a safe callback binding.
    for (const node of tree.rootNode.descendantsOfType('identifier'))
      bindings.set(node.id, `emitted:${node.text}`);
    const tools = extractToolDefinitions(tree, 'server.ts', 0, bindings);
    expect(tools.map((tool) => tool.toolName)).toEqual([
      'parameter',
      'shadowed',
      'alias',
      'imported',
      'mutable',
      'reassigned',
      'duplicate',
      'before-initialization',
    ]);
    expect(
      tools.every((tool) => tool.handlerNodeId === undefined && tool.allowFileFallback === false),
    ).toBe(true);
  });
});
