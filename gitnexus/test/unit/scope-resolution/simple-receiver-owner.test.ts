import { expect, it } from 'vitest';
import type { SymbolDefinition } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { typescriptScopeResolver } from '../../../src/core/ingestion/languages/typescript/scope-resolver.js';
import { createSemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';
import { buildGraphNodeLookup } from '../../../src/core/ingestion/scope-resolution/graph-bridge/node-lookup.js';
import { emitReceiverBoundCalls } from '../../../src/core/ingestion/scope-resolution/passes/receiver-bound-calls.js';
import { buildScopeModel } from '../../helpers/scope-model.js';

it.each(['selection', 'source binding'])(
  'observes a %s callback changing the same declared type',
  (callback) => {
    const fixture = buildScopeModel(
      typescriptScopeResolver,
      'class Left {} class Right {} function member() {} function run(x: Chosen) { x.first(); x.second(); }',
      'receiver.ts',
    );
    const def = (name: string) => fixture.parsed.localDefs.find((d) => d.qualifiedName === name)!;
    const bindings = new Map(fixture.scopes.workspaceFqnBindings);
    const select = (owner: string) =>
      bindings.set('Chosen', [{ origin: 'local', def: def(owner) }]);
    select('Left');
    const owners: string[] = [];
    const graph = createKnowledgeGraph();
    emitReceiverBoundCalls(
      graph,
      { ...fixture.scopes, workspaceFqnBindings: bindings },
      [fixture.parsed],
      buildGraphNodeLookup(graph),
      new Set(),
      {
        ...typescriptScopeResolver,
        resolveReceiverMember: (owner: SymbolDefinition) => {
          owners.push(owner.qualifiedName);
          return { kind: 'resolved', definition: def('member') };
        },
      },
      fixture.index,
      createSemanticModel(),
      callback === 'selection'
        ? { onSelectedCall: () => select('Right') }
        : {
            recordSourceBinding: (site) => {
              if (site.name === 'second') select('Right');
            },
          },
    );
    expect(owners).toEqual(['Left', 'Right']);
  },
);
