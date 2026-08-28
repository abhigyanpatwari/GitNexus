import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CypherExecutor } from '../../../src/core/group/contract-extractor.js';
import { GraphqlExtractor } from '../../../src/core/group/extractors/graphql-extractor.js';
import type { RepoHandle } from '../../../src/core/group/types.js';
import { cleanupTempDir } from '../../helpers/test-db.js';

const tempDirs: string[] = [];

async function makeRepo(
  files: Record<string, string>,
): Promise<{ root: string; repo: RepoHandle }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-graphql-'));
  tempDirs.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
  }
  return {
    root,
    repo: { id: 'test', path: 'app', repoPath: root, storagePath: path.join(root, '.gitnexus') },
  };
}

function executor(symbols: Record<string, Array<Record<string, unknown>>>): CypherExecutor {
  return async (_query, params = {}) => {
    const name = String(params.name ?? '');
    const filePath = params.filePath ? `@${String(params.filePath)}` : '';
    return symbols[`${name}${filePath}`] ?? symbols[name] ?? [];
  };
}

function generatedDocument(
  operation: 'query' | 'mutation' | 'subscription',
  name: string,
  fields: string[],
): string {
  const selections = fields
    .map((field) => `{ kind: 'Field', name: { kind: 'Name', value: '${field}' } }`)
    .join(', ');
  return `{ kind: 'Document', definitions: [{
    kind: 'OperationDefinition',
    operation: '${operation}',
    name: { kind: 'Name', value: '${name}' },
    selectionSet: { kind: 'SelectionSet', selections: [${selections}] }
  }] }`;
}

describe('GraphqlExtractor', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => cleanupTempDir(dir)));
  });

  it('anchors NestJS providers and document consumers to exact real symbols', async () => {
    const { root, repo } = await makeRepo({
      'src/widget.resolver.ts': `
import { Resolver, Query as GqlQuery, Mutation, Subscription } from '@nestjs/graphql';
@Resolver()
class WidgetResolver {
  @GqlQuery(() => Widget, { name: 'widget' })
  fetchWidget() { return null; }
  @Mutation('saveWidget')
  save() { return null; }
  @Subscription()
  widgetChanged() { return null; }
}`,
      'src/widget.graphql': `
fragment WidgetRoot on Query { widget }
query GetWidget { alias: widget ...WidgetRoot }
mutation SaveWidget { saveWidget }
subscription WatchWidget { widgetChanged }
`,
      'src/generated.ts': `
export const GetWidgetDocument = ${generatedDocument('query', 'GetWidget', ['widget'])};
export const SaveWidgetDocument = ${generatedDocument('mutation', 'SaveWidget', ['saveWidget'])};
export const WatchWidgetDocument = ${generatedDocument('subscription', 'WatchWidget', ['widgetChanged'])};
`,
    });
    const run = executor({
      'fetchWidget@src/widget.resolver.ts': [
        { uid: 'method:fetch', name: 'fetchWidget', filePath: 'src/widget.resolver.ts' },
      ],
      'save@src/widget.resolver.ts': [
        { uid: 'method:save', name: 'save', filePath: 'src/widget.resolver.ts' },
      ],
      'widgetChanged@src/widget.resolver.ts': [
        { uid: 'method:watch', name: 'widgetChanged', filePath: 'src/widget.resolver.ts' },
      ],
      GetWidgetDocument: [
        { uid: 'const:get', name: 'GetWidgetDocument', filePath: 'src/generated.ts' },
      ],
      SaveWidgetDocument: [
        { uid: 'const:save', name: 'SaveWidgetDocument', filePath: 'src/generated.ts' },
      ],
      WatchWidgetDocument: [
        { uid: 'const:watch', name: 'WatchWidgetDocument', filePath: 'src/generated.ts' },
      ],
    });

    const contracts = await new GraphqlExtractor().extract(run, root, repo);

    expect(
      contracts.map((contract) => [contract.contractId, contract.role, contract.symbolUid]),
    ).toEqual([
      ['graphql::query::widget', 'provider', 'method:fetch'],
      ['graphql::mutation::saveWidget', 'provider', 'method:save'],
      ['graphql::subscription::widgetChanged', 'provider', 'method:watch'],
      ['graphql::query::widget', 'consumer', 'const:get'],
      ['graphql::mutation::saveWidget', 'consumer', 'const:save'],
      ['graphql::subscription::widgetChanged', 'consumer', 'const:watch'],
    ]);
  });

  it('skips unproven decorators, ambiguous anchors, anonymous operations, and invalid documents', async () => {
    const { root, repo } = await makeRepo({
      'src/not-nest.ts': `
function Query(): MethodDecorator { return () => undefined; }
class LocalResolver { @Query() localOnly() {} }`,
      'src/ambiguous.resolver.ts': `
import { Query } from '@nestjs/graphql';
class AmbiguousResolver { @Query() widget() {} }`,
      'src/anonymous.graphql': `query { widget }`,
      'src/invalid.graphql': `query Broken {`,
      'src/missing.graphql': `query MissingGenerated { widget }`,
    });
    const ambiguous = [
      { uid: 'method:a', name: 'widget', filePath: 'src/ambiguous.resolver.ts' },
      { uid: 'method:b', name: 'widget', filePath: 'src/ambiguous.resolver.ts' },
    ];

    const contracts = await new GraphqlExtractor().extract(
      executor({ 'widget@src/ambiguous.resolver.ts': ambiguous }),
      root,
      repo,
    );

    expect(contracts).toEqual([]);
  });

  it('rejects provider fields that are not GraphQL Names', async () => {
    const { root, repo } = await makeRepo({
      'src/invalid.resolver.ts': `
import { Query } from '@nestjs/graphql';
class InvalidResolver {
  @Query('bad::field') separator() {}
  @Query('line\\nfeed') newline() {}
  @Query('right\\u202etoLeft') bidi() {}
  @Query('9startsWithDigit') digit() {}
}`,
    });
    let lookups = 0;
    const run: CypherExecutor = async () => {
      lookups++;
      return [{ uid: 'method:invalid', name: 'invalid', filePath: 'src/invalid.resolver.ts' }];
    };

    expect(await new GraphqlExtractor().extract(run, root, repo)).toEqual([]);
    expect(lookups).toBe(0);
  });

  it('skips a provider file whose AST exceeds the traversal depth cap', async () => {
    const nested = `${'['.repeat(300)}0${']'.repeat(300)}`;
    const { root, repo } = await makeRepo({
      'src/deep.resolver.ts': `
import { Query } from '@nestjs/graphql';
const nested = ${nested};
class DeepResolver { @Query() health() {} }`,
    });
    let lookups = 0;

    expect(
      await new GraphqlExtractor().extract(
        async () => {
          lookups++;
          return [{ uid: 'method:health', name: 'health', filePath: 'src/deep.resolver.ts' }];
        },
        root,
        repo,
      ),
    ).toEqual([]);
    expect(lookups).toBe(0);
  });

  it('uses an exact unique Document symbol when no generated hook exists', async () => {
    const { root, repo } = await makeRepo({
      'src/health.graphql': `query Health { health }`,
      'src/generated/graphql.ts': `export const HealthDocument = ${generatedDocument('query', 'Health', ['health'])};`,
    });

    const contracts = await new GraphqlExtractor().extract(
      executor({
        HealthDocument: [
          { uid: 'var:health', name: 'HealthDocument', filePath: 'src/generated/graphql.ts' },
        ],
      }),
      root,
      repo,
    );

    expect(contracts).toEqual([
      expect.objectContaining({
        contractId: 'graphql::query::health',
        role: 'consumer',
        symbolUid: 'var:health',
        symbolRef: { filePath: 'src/generated/graphql.ts', name: 'HealthDocument' },
      }),
    ]);
  });

  it('skips matching tokens that occur only in unrelated initializer metadata', async () => {
    const { root, repo } = await makeRepo({
      'src/health.graphql': `query Health { health }`,
      'src/generated/graphql.ts': `export const HealthDocument = {
        metadata: { operation: 'Health', field: 'health' },
        kind: 'NotADocument'
      };`,
    });

    const contracts = await new GraphqlExtractor().extract(
      executor({
        HealthDocument: [
          { uid: 'var:health', name: 'HealthDocument', filePath: 'src/generated/graphql.ts' },
        ],
      }),
      root,
      repo,
    );

    expect(contracts).toEqual([]);
  });

  it('fails closed when a generated Document initializer exceeds the AST depth budget', async () => {
    const { root, repo } = await makeRepo({
      'src/deep.graphql': `query Deep { health }`,
      'src/generated.ts': `export const DeepDocument = ${'('.repeat(300)}${generatedDocument(
        'query',
        'Deep',
        ['health'],
      )}${')'.repeat(300)};`,
    });

    const contracts = await new GraphqlExtractor().extract(
      executor({
        DeepDocument: [{ uid: 'const:deep', name: 'DeepDocument', filePath: 'src/generated.ts' }],
      }),
      root,
      repo,
    );

    expect(contracts).toEqual([]);
  });

  it('fails closed for oversized, deeply nested, and excessive-operation documents', async () => {
    const nested = `${'... on Query { '.repeat(65)}health${' }'.repeat(65)}`;
    const manyOperations = Array.from(
      { length: 501 },
      (_, index) => `query Op${index} { field${index} }`,
    ).join('\n');
    const { root, repo } = await makeRepo({
      'src/oversized.graphql': `${' '.repeat(1_000_001)}query Huge { huge }`,
      'src/deep.graphql': `query Deep { ${nested} }`,
      'src/many.graphql': manyOperations,
    });
    let lookups = 0;
    const run: CypherExecutor = async (_query, params = {}) => {
      lookups++;
      const name = String(params.name ?? '');
      return name.startsWith('useOp')
        ? [{ uid: `fn:${name}`, name, filePath: 'src/generated.ts' }]
        : name === 'useDeepQuery'
          ? [{ uid: 'fn:deep', name, filePath: 'src/generated.ts' }]
          : [];
    };

    const contracts = await new GraphqlExtractor().extract(run, root, repo);

    expect(contracts).toEqual([]);
    expect(contracts).not.toContainEqual(expect.objectContaining({ symbolUid: 'fn:deep' }));
    expect(lookups).toBe(0);
  });
});
