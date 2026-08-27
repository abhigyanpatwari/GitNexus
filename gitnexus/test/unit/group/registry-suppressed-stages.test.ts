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
