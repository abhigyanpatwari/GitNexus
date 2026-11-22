import { expect, it, vi } from 'vitest';
import type { ReferenceSite } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { typescriptScopeResolver } from '../../../src/core/ingestion/languages/typescript/scope-resolver.js';
import { createSemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';
import { buildGraphNodeLookup } from '../../../src/core/ingestion/scope-resolution/graph-bridge/node-lookup.js';
import { emitReceiverBoundCalls } from '../../../src/core/ingestion/scope-resolution/passes/receiver-bound-calls.js';
import { buildScopeModel } from '../../helpers/scope-model.js';

it('skips receiver setup for free calls and checks the current sites on replay', () => {
  const fixture = buildScopeModel(
    typescriptScopeResolver,
    'export function run(x: Service) { helper(); x.save(); }',
    'service.ts',
  );
  const member = fixture.sites.find((site) => site.kind === 'call' && site.name === 'save')!;
  const free = fixture.sites.find((site) => site.kind === 'call' && site.name === 'helper')!;
  const referenceSites: ReferenceSite[] = [free, { ...member, kind: 'type-reference' }];
  const file = { ...fixture.parsed, referenceSites };
  const graph = createKnowledgeGraph();
  const nodes = buildGraphNodeLookup(graph);
  const model = createSemanticModel();
  const setup = vi.fn(() => () => undefined);
  const provider = { ...typescriptScopeResolver, createReceiverNamespaceResolver: setup };
  const run = () =>
    emitReceiverBoundCalls(
      graph,
      fixture.scopes,
      [file],
      nodes,
      new Set(),
      provider,
      fixture.index,
      model,
    );

  expect(run().emitted).toBe(0);
  expect(setup).not.toHaveBeenCalled();
  referenceSites.push(member);
  run();
  expect(setup).toHaveBeenCalledTimes(1);
  file.referenceSites = [free];
  run();
  expect(setup).toHaveBeenCalledTimes(1);
});
