/**
 * Live end-to-end Move ingestion against the real move-flow binary.
 *
 * Gated on move-flow being installed (skipped in CI without the binary). Proves
 * the full compiler-first chain: capability probe → facts query → thin
 * facts→graph mapper → pipeline graph, with full fidelity (resource/friend
 * edges, resource structs, precise locations).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { tryCreateMoveFlowClient } from '../../src/core/move/mcp-client.js';
import { createMoveIngestPhase } from '../../src/core/move/move-ingest.js';
import { runMoveIngestPhase } from '../helpers/move-ingest-harness.js';

const client = tryCreateMoveFlowClient();
const coinFixture = path.resolve(process.cwd(), 'test/fixtures/move/aptos-framework/coin');

function writePackage(root: string, name: string, addr: string, source: string): void {
  mkdirSync(path.join(root, 'sources'), { recursive: true });
  writeFileSync(
    path.join(root, 'Move.toml'),
    `[package]\nname = "${name}"\nversion = "1.0.0"\n\n[addresses]\n${addr} = "0x42"\n`,
  );
  writeFileSync(path.join(root, 'sources', 'mod.move'), source);
}

/** Run just the moveIngest phase on a one-package repo, returning its issues. */
async function ingestIssues(repoRoot: string) {
  const output = await runMoveIngestPhase(client, repoRoot, ['Move.toml', 'sources/mod.move']);
  return output.consistencyIssues;
}

describe.skipIf(!client)('live move-flow ingestion (coin fixture)', () => {
  afterAll(async () => {
    await client?.shutdown();
  });

  it('detects the facts query capability', async () => {
    const caps = await client!.capabilities();
    expect(caps.hasFactsQuery).toBe(true);
  });

  it('builds a full-fidelity Move graph from compiler facts', async () => {
    const result = await runPipelineFromRepo(coinFixture, () => {}, {
      standaloneIngestPhase: createMoveIngestPhase(client),
      skipGraphPhases: true,
    });
    const nodes = [...result.graph.iterNodes()];
    const edges = [...result.graph.iterRelationships()];

    const moveFns = nodes.filter((n) => n.label === 'Function' && n.properties.language === 'move');
    expect(moveFns.some((n) => n.properties.name === 'register' && n.properties.isEntry)).toBe(
      true,
    );
    expect(moveFns.some((n) => n.properties.name === 'balance_of' && n.properties.isView)).toBe(
      true,
    );

    const coinStore = nodes.find((n) => n.label === 'Struct' && n.properties.name === 'CoinStore');
    expect(coinStore?.properties.isResource).toBe(true);
    expect(coinStore?.properties.locationFidelity).toBe('precise');

    expect(edges.some((e) => e.type === 'WRITES_RESOURCE')).toBe(true);
    expect(edges.some((e) => e.type === 'FRIEND_OF')).toBe(true);
    expect(edges.some((e) => e.type === 'DEFINES')).toBe(true);

    // returnTypes -> scalar returnType projection.
    const balanceOf = moveFns.find((n) => n.properties.name === 'balance_of');
    expect(balanceOf?.properties.returnType).toBe('u64');
    const register = moveFns.find((n) => n.properties.name === 'register');
    expect(register?.properties.returnType).toBeUndefined();
    // burn_internal returns CoinStore<CoinType> -> a move-fn-return-type edge.
    const burn = moveFns.find((n) => n.properties.name === 'burn_internal');
    expect(burn?.properties.returnType).toContain('CoinStore');
    expect(
      edges.some(
        (e) =>
          e.type === 'USES_TYPE' &&
          e.reason === 'move-fn-return-type' &&
          e.sourceId === burn?.id &&
          e.targetId === coinStore?.id,
      ),
    ).toBe(true);
    expect(burn?.properties.usedTypes).toContain(coinStore?.properties.qualifiedName);
  }, 60000);

  it('serves the post-2.0.0 facts wire shape (returnTypes arrays, lambda-lift fields, no legacy returnType)', async () => {
    const factsMap = await client!.facts(coinFixture);
    const fns = Object.values(factsMap).flatMap((mod) => mod.functions ?? []);
    expect(fns.length).toBeGreaterThan(0);
    for (const fn of fns) {
      expect(Array.isArray(fn.returnTypes)).toBe(true);
      expect(typeof fn.isLambdaLifted).toBe('boolean');
      expect('returnType' in fn).toBe(false);
    }
    const burn = fns.find((fn) => fn.name === 'burn_internal');
    expect(burn?.returnTypes).toHaveLength(1);
    expect(burn?.returnTypes[0]).toContain('CoinStore');
  }, 60000);

  it('reports build status for a compiling package', async () => {
    const caps = await client!.capabilities();
    expect(caps.hasStatusTool).toBe(true);
    const status = await client!.packageStatus(coinFixture);
    expect(status.ok).toBe(true);
  }, 60000);

  it('discriminates test-only from broken empty-facts packages via move_package_status', async () => {
    // Both packages return facts `{}` with isError:false - byte-identical on
    // the wire. Only the build-status cross-check tells them apart.
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-move-status-'));
    try {
      const testonly = path.join(tmp, 'testonly');
      writePackage(
        testonly,
        'live_testonly',
        't',
        '#[test_only]\nmodule t::helpers { public fun one(): u64 { 1 } }\n',
      );
      const testonlyIssues = await ingestIssues(testonly);
      const testonlyEmpties = testonlyIssues.filter((i) => i.code === 'empty-package-facts');
      expect(testonlyEmpties).toHaveLength(1);
      expect(testonlyEmpties[0].severity).toBe('warning');
      expect(testonlyIssues.some((i) => i.severity === 'error')).toBe(false);

      const broken = path.join(tmp, 'broken');
      writePackage(
        broken,
        'live_broken',
        'b',
        'module b::broken {\n  public fun oops(): u64 { 1 +\n}\n',
      );
      const brokenIssues = await ingestIssues(broken);
      const brokenEmpties = brokenIssues.filter((i) => i.code === 'empty-package-facts');
      expect(brokenEmpties).toHaveLength(1);
      expect(brokenEmpties[0].severity).toBe('error');
      expect(brokenEmpties[0].message).toContain('does not compile');
      expect(String(brokenEmpties[0].details?.diagnostics)).toContain('error');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 300000);
});
