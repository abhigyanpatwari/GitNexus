/**
 * `suppressedMatchStages` — what a sync says about the stages it was told to skip.
 *
 * `--exact-only` / `exactOnly` suppresses the wildcard matching stage. The
 * registry it writes is otherwise indistinguishable from one where that stage
 * ran and matched nothing, and `group_impact` / cross-repo `trace` read that
 * registry as authoritative. So the sync has to say so.
 *
 * The tri-state is the same one `unreadableRepos` uses, and the reason is the
 * same: ABSENT means a registry written before the field existed and therefore
 * has no opinion; EMPTY is a measurement — this run suppressed nothing;
 * POPULATED names the stages. Normalizing absent to `[]` would report an
 * unmeasured registry as a clean one.
 *
 * Two properties here are easy to get wrong and are pinned deliberately:
 * the returned result carries the marker on EVERY outcome (the sync really did
 * skip the stage whatever happened to the file), while the persisted registry
 * stamps it only on the outcome that writes this run's contracts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncGroup } from '../../../src/core/group/sync.js';
import { makeWildcardPair } from './fixtures.js';
import { crossRepoCompleteness } from '../../../src/core/group/completeness.js';
import { GROUP_IMPACT_TRUNCATION_REASONS } from '../../../src/core/group/types.js';
import type {
  GroupConfig,
  StoredContract,
  ContractRegistry,
} from '../../../src/core/group/types.js';

const config: GroupConfig = {
  version: 1,
  name: 'suppressed',
  description: '',
  repos: { 'app/provider': 'provider-repo', 'app/consumer': 'consumer-repo' },
  links: [],
  packages: {},
  detect: {
    http: true,
    grpc: false,
    thrift: false,
    topics: false,
    includes: false,
    workspace_deps: false,
  },
  matching: {
    exclude_links_paths: [],
    exclude_links_param_only_paths: false,
  },
};

const { provider, consumer } = makeWildcardPair();

let groupDir: string;

beforeEach(() => {
  groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-suppressed-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(groupDir, { recursive: true, force: true });
});

const run = (exactOnly: boolean, opts: { write: boolean } = { write: false }) =>
  syncGroup(config, {
    extractorOverride: async () => [provider, consumer],
    exactOnly,
    ...(opts.write ? { groupDir } : { skipWrite: true }),
  });

const readRegistry = (): ContractRegistry =>
  JSON.parse(fs.readFileSync(path.join(groupDir, 'contracts.json'), 'utf8')) as ContractRegistry;

describe('a sync records the matching stages it was told to skip', () => {
  it('names the wildcard stage when exactOnly suppressed it', async () => {
    const result = await run(true);

    expect(result.suppressedMatchStages).toEqual(['wildcard']);
    expect(result.crossLinks).toEqual([]);
  });

  // control: the marker tracks the request, not a constant. Without this, a
  // hardcoded `['wildcard']` would pass the case above.
  it('control: measures an empty list when no stage was suppressed', async () => {
    const result = await run(false);

    expect(result.suppressedMatchStages).toEqual([]);
    expect(result.crossLinks).toHaveLength(1);
    expect(result.crossLinks[0].matchType).toBe('wildcard');
  });

  it('persists the marker into contracts.json on a written sync', async () => {
    await run(true, { write: true });

    expect(readRegistry().suppressedMatchStages).toEqual(['wildcard']);
  });

  it('persists an empty measurement, not an absent key, on an unsuppressed sync', async () => {
    await run(false, { write: true });

    const registry = readRegistry();
    expect(registry.suppressedMatchStages).toEqual([]);
    // The distinction the tri-state exists for: a measured zero is not silence.
    expect(registry).toHaveProperty('suppressedMatchStages');
  });
});

/**
 * The half that matters to a later reader: does a narrowed graph still claim
 * to be complete? `crossRepoCompleteness` is the ONE computation behind the
 * truncation triple that `group_impact`, cross-repo `trace` and the contract
 * listing all return, so pinning it here covers all three.
 */
describe('cross-repo completeness reflects a suppressed stage', () => {
  it('reports a floor, with its own reason, when a stage was suppressed', () => {
    const out = crossRepoCompleteness({
      unreadableRepos: [],
      missingRepos: [],
      suppressedMatchStages: ['wildcard'],
      provenanceUnknown: false,
      inScope: () => true,
    });

    expect(out.truncated).toBe(true);
    expect(out.truncationReason).toBe('suppressed-stage');
    expect(out.riskEpistemic).toBe('lower-bound');
  });

  // control: without a suppressed stage the same clean input is complete.
  // Without this, hardcoding `truncated: true` would pass the case above.
  it('control: a clean sync with nothing suppressed is not truncated', () => {
    const out = crossRepoCompleteness({
      unreadableRepos: [],
      missingRepos: [],
      suppressedMatchStages: [],
      provenanceUnknown: false,
      inScope: () => true,
    });

    expect(out.truncated).toBe(false);
    expect(out.truncationReason).toBeUndefined();
  });

  // An unreadable repo is the more serious gap and its remedy differs, so it
  // has to win the reason slot rather than being masked by the flag.
  it('lets an unreadable repo outrank a suppressed stage in the reason', () => {
    const out = crossRepoCompleteness({
      unreadableRepos: ['app/backend'],
      missingRepos: [],
      suppressedMatchStages: ['wildcard'],
      provenanceUnknown: false,
      inScope: () => true,
    });

    expect(out.truncated).toBe(true);
    expect(out.truncationReason).toBe('incomplete-sync');
  });
});

/**
 * The reason has to be REACHABLE, not just documented.
 *
 * A guard in `tools.test.ts` asserts every truncation reason is explained in
 * the impact tool description. That check passed while `runGroupImpact`
 * hardcoded its fallback and could never emit `'suppressed-stage'` — a
 * documented value no surface could produce. These pin the emitting side.
 */
describe('the suppressed-stage reason is reachable, not just documented', () => {
  it('is the reason when a stage was suppressed and every repo read fine', () => {
    const out = crossRepoCompleteness({
      unreadableRepos: [],
      missingRepos: [],
      suppressedMatchStages: ['wildcard'],
      provenanceUnknown: false,
      inScope: () => true,
    });

    expect(out.truncated).toBe(true);
    expect(out.truncationReason).toBe('suppressed-stage');
  });

  it('is a declared member of the reason union agents branch on', () => {
    // If a future change drops it from the union, the tool description guard
    // would still pass while every consumer lost the value.
    expect(GROUP_IMPACT_TRUNCATION_REASONS).toContain('suppressed-stage');
  });
});
