import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _captureLogger } from '../../../src/core/logger.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type {
  ContractRegistry,
  ExtractedContract,
  GroupConfig,
  GroupManifestLink,
  RepoHandle,
} from '../../../src/core/group/types.js';

/**
 * Per-repo extraction is all-or-nothing.
 *
 * `syncGroup` runs each enabled extractor for a repo in sequence and any one of
 * them can throw. Appending results to the shared `autoContracts` as they were
 * produced meant a repo whose HTTP extractor succeeded and whose gRPC extractor
 * then failed contributed a partial set to contracts.json — while the catch that
 * caught the failure told the operator that repo's "contracts are omitted from
 * this sync", and `group sync` printed the same. The persisted registry held an
 * undocumented partial view of a repo that the diagnostics described as absent.
 *
 * Nothing about the earlier extractor's output is wrong in isolation. What makes
 * it unusable is that no reader can tell which repos are complete: a contract
 * that is silently absent reads exactly like a contract that does not exist.
 */

const PARTIAL_CONTRACT: ExtractedContract = {
  contractId: 'http::GET::/api/users',
  type: 'http',
  role: 'provider',
  symbolUid: 'Function:src/users.ts:listUsers',
  symbolRef: { filePath: 'src/users.ts', name: 'listUsers' },
  symbolName: 'listUsers',
  confidence: 1,
  meta: {},
};

const httpExtract = vi.fn();
const grpcExtract = vi.fn();
// Bound through an arrow so the test body can read its calls: which repos the
// deferred manifest phase re-opens is the observable side of dropping a failed
// repo's handle, and a `vi.fn()` created inside the factory is unreachable here.
const initLbugMock = vi.fn(async () => {});

vi.mock('../../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: (...args: unknown[]) => initLbugMock(...args),
  executeParameterized: vi.fn(async () => []),
  pinRepo: vi.fn(() => () => {}),
  getMaxResidentRepos: vi.fn(() => 5),
}));

vi.mock('../../../src/storage/repo-manager.js', () => ({
  readRegistry: vi.fn(async () => []),
  readRegistryStrict: vi.fn(async () => []),
}));

vi.mock('../../../src/core/group/extractors/http-route-extractor.js', () => ({
  HttpRouteExtractor: class {
    extract = (...args: unknown[]) => httpExtract(...args);
  },
}));

vi.mock('../../../src/core/group/extractors/grpc-extractor.js', () => ({
  GrpcExtractor: class {
    extract = (...args: unknown[]) => grpcExtract(...args);
  },
}));

const { syncGroup } = await import('../../../src/core/group/sync.js');

const handle: RepoHandle = {
  id: 'pool-backend',
  path: '/repos/backend',
  repoPath: '/repos/backend',
  storagePath: '/repos/backend/.gitnexus',
};

const config = (): GroupConfig => ({
  version: 1,
  name: 'test',
  description: '',
  repos: { 'app/backend': 'backend-repo' },
  links: [],
  packages: {},
  detect: {
    http: true,
    grpc: true,
    thrift: false,
    topics: false,
    includes: false,
    workspace_deps: false,
  },
  matching: {},
});

describe('syncGroup when one extractor fails partway through a repo', () => {
  let groupDir: string;

  beforeEach(() => {
    httpExtract.mockReset();
    grpcExtract.mockReset();
    groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sync-partial-'));
  });

  afterEach(() => {
    fs.rmSync(groupDir, { recursive: true, force: true });
  });

  it('keeps none of that repo’s contracts, matching what the diagnostics say', async () => {
    httpExtract.mockResolvedValue([PARTIAL_CONTRACT]);
    grpcExtract.mockRejectedValue(new Error('gRPC extraction failed'));

    const result = await syncGroup(config(), {
      groupDir,
      resolveRepoHandle: async () => handle,
    });

    expect(httpExtract).toHaveBeenCalledTimes(1);
    expect(result.unreadableRepos).toEqual(['app/backend']);
    // The contract the HTTP extractor produced is discarded with the rest of
    // the repo. Anything else contradicts the warning the same run emits.
    expect(result.contracts).toEqual([]);
  });

  it('keeps every contract when all enabled extractors succeed', async () => {
    // The control: the all-or-nothing rule must not cost the happy path its
    // output, which a guard that simply dropped `repoContracts` would.
    httpExtract.mockResolvedValue([PARTIAL_CONTRACT]);
    grpcExtract.mockResolvedValue([]);

    const result = await syncGroup(config(), {
      groupDir,
      resolveRepoHandle: async () => handle,
    });

    expect(result.unreadableRepos).toEqual([]);
    expect(result.contracts).toHaveLength(1);
    expect(result.contracts[0].contractId).toBe('http::GET::/api/users');
    expect(result.contracts[0].repo).toBe('app/backend');
  });
});

/**
 * The staged contracts must be appended by a BOUNDED construct.
 *
 * Staging (above) is what made the append dangerous. Before it, each extractor's
 * output was appended as it came back, so `autoContracts.push(...)` only ever
 * spread one extractor's contracts; staging makes it spread the whole repo's.
 * A spread call passes every element as a separate ARGUMENT, and the engine caps
 * how many arguments a call can take — so a repo that stages enough contracts
 * kills the sync with `RangeError: Maximum call stack size exceeded` on the one
 * line whose job is to commit the work that just succeeded.
 *
 * This gate is structural rather than size-based ON PURPOSE. The argument limit
 * is a function of the host's available stack: this machine accepts a 125k-element
 * spread and dies at 150k, and a larger-stack host sails past both. A "make the
 * fixture big enough to crash" test therefore passes against unfixed code on some
 * hosts — which is precisely the guarantee a regression gate cannot give up. The
 * size test below is a completeness/ordering check, not the guard.
 *
 * Scope: the per-repo extractor `try` block ONLY. `sync.ts` also spreads in the
 * windowed manifest loop (`autoContracts.push(...windowResult.contracts)` and its
 * cross-link twin). Those predate this change, are bounded by the window size,
 * and are not what this gate is about — a text scan keyed on `autoContracts.push(...`
 * would match them too and fail on code this change never touches. So the region
 * is located by AST and by ROLE, not by name: the `const … : StoredContract[] = []`
 * staging buffer declared per repo (the function-scoped `let autoContracts` is
 * excluded by the `const`), then the one `try` whose block references it. Renaming
 * either identifier keeps the gate pointed at the same code.
 *
 * `.apply(` is rejected alongside the spread: `push.apply(dest, staged)` is the
 * same argument-limit hazard wearing different syntax.
 */
const SYNC_SOURCE_PATH = fileURLToPath(new URL('../../../src/core/group/sync.ts', import.meta.url));

/** Every node under `node`, in source order. No branching, so nothing is skippable. */
function descendants(node: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    out.push(n);
    n.forEachChild(visit);
  };
  node.forEachChild(visit);
  return out;
}

/** `const <name>: StoredContract[] = []` — the per-repo staging buffer. */
function isStagingBufferDeclaration(node: ts.Node): node is ts.VariableDeclaration {
  return (
    ts.isVariableDeclaration(node) &&
    node.type !== undefined &&
    ts.isArrayTypeNode(node.type) &&
    ts.isTypeReferenceNode(node.type.elementType) &&
    ts.isIdentifier(node.type.elementType.typeName) &&
    node.type.elementType.typeName.text === 'StoredContract' &&
    node.initializer !== undefined &&
    ts.isArrayLiteralExpression(node.initializer) &&
    node.initializer.elements.length === 0 &&
    ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

/** `x.apply(dest, args)` — an argument-limited append in non-spread clothing. */
function isApplyCall(call: ts.CallExpression): boolean {
  return ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'apply';
}

function describeCall(sourceFile: ts.SourceFile, call: ts.CallExpression): string {
  const { line } = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile));
  return `${line + 1}: ${call.getText(sourceFile).replace(/\s+/g, ' ')}`;
}

describe('the per-repo staging append in sync.ts', () => {
  it('appends the staged contracts without spreading them into a call', () => {
    const source = fs.readFileSync(SYNC_SOURCE_PATH, 'utf-8');
    const sourceFile = ts.createSourceFile(
      SYNC_SOURCE_PATH,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const allNodes = descendants(sourceFile);
    const stagingBuffers = allNodes.filter(isStagingBufferDeclaration);
    // One staging buffer, or this gate no longer knows which code it guards.
    expect(stagingBuffers.map((d) => d.name.getText(sourceFile))).toHaveLength(1);
    const stagingNames = stagingBuffers.map((d) => d.name.getText(sourceFile));

    // The block the buffer is declared in — the per-repo loop body.
    const declaringBlocks = stagingBuffers
      .map((d) => d.parent.parent.parent) // declaration → list → statement → block
      .filter(ts.isBlock);
    expect(declaringBlocks).toHaveLength(1);

    // The extractor try-block: a DIRECT statement of that block whose `try` reads
    // the staging buffer. Direct statements only, deliberately — `syncGroup` wraps
    // this whole section in its own try/finally (the lease sweep), and that
    // ancestor reads the buffer too. Widening to "any try that mentions it" pulls
    // in the entire function body, manifest-window spreads and all.
    const extractorTryBlocks = declaringBlocks.flatMap((block) =>
      block.statements
        .filter(ts.isTryStatement)
        .filter((statement) =>
          descendants(statement.tryBlock).some(
            (n) => ts.isIdentifier(n) && stagingNames.includes(n.text),
          ),
        )
        .map((statement) => statement.tryBlock),
    );
    expect(extractorTryBlocks).toHaveLength(1);

    const unboundedAppends = extractorTryBlocks.flatMap((block) =>
      descendants(block)
        .filter(ts.isCallExpression)
        .filter((call) => call.arguments.some(ts.isSpreadElement) || isApplyCall(call))
        .map((call) => describeCall(sourceFile, call)),
    );

    // Every staged contract must reach `autoContracts` through a bounded loop:
    // the count a repo can stage is then bounded by memory, not by how much
    // stack the host happened to give this process.
    expect(unboundedAppends).toEqual([]);
  });
});

/**
 * A repo can stage more contracts than a call is allowed to take as arguments.
 * 200_000 is over this host's measured spread ceiling (~125k) and under nothing
 * in particular — the point is that the count is bounded by memory now, so the
 * assertion is that all of them arrive, in the order the extractors produced them.
 */
const LARGE_CONTRACT_COUNT = 200_000;

describe('syncGroup appending a repo that staged a large contract count', () => {
  let groupDir: string;

  beforeEach(() => {
    httpExtract.mockReset();
    grpcExtract.mockReset();
    groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sync-bulk-'));
  });

  afterEach(() => {
    fs.rmSync(groupDir, { recursive: true, force: true });
  });

  it('keeps every staged contract, in order', async () => {
    const staged: ExtractedContract[] = Array.from({ length: LARGE_CONTRACT_COUNT }, (_, i) => ({
      ...PARTIAL_CONTRACT,
      contractId: `http::GET::/api/item/${i}`,
      symbolUid: `Function:src/items.ts:item${i}`,
    }));
    httpExtract.mockResolvedValue(staged);
    grpcExtract.mockResolvedValue([]);

    const result = await syncGroup(config(), {
      groupDir,
      // Nothing here is about persistence; writing a 200k-contract registry and
      // bridge would only make the test slow.
      skipWrite: true,
      resolveRepoHandle: async () => handle,
    });

    // An argument-limit RangeError lands in the per-repo catch, so an unbounded
    // append shows up here as an "unreadable" repo with zero contracts — the
    // extraction that actually succeeded, reported as an unreadable index.
    expect(result.unreadableRepos).toEqual([]);
    expect(result.contracts).toHaveLength(LARGE_CONTRACT_COUNT);
    const firstOutOfOrder = result.contracts.findIndex(
      (c, i) => c.contractId !== `http::GET::/api/item/${i}`,
    );
    expect(firstOutOfOrder).toBe(-1);
  }, 30_000);

  it('appends an ordinary repo’s contracts in the order the extractors produced them', async () => {
    // The control. Ordering across extractors is observable in contracts.json
    // and in every consumer of it, so the bounded append has to reproduce the
    // sequence the spread produced: HTTP contracts first, then gRPC, each in
    // the extractor's own order.
    const httpContracts: ExtractedContract[] = ['a', 'b', 'c'].map((suffix) => ({
      ...PARTIAL_CONTRACT,
      contractId: `http::GET::/api/${suffix}`,
    }));
    const grpcContracts: ExtractedContract[] = ['x', 'y'].map((suffix) => ({
      ...PARTIAL_CONTRACT,
      type: 'grpc',
      contractId: `grpc::svc.Service/${suffix}`,
    }));
    httpExtract.mockResolvedValue(httpContracts);
    grpcExtract.mockResolvedValue(grpcContracts);

    const result = await syncGroup(config(), {
      groupDir,
      resolveRepoHandle: async () => handle,
    });

    expect(result.unreadableRepos).toEqual([]);
    expect(result.contracts.map((c) => c.contractId)).toEqual([
      'http::GET::/api/a',
      'http::GET::/api/b',
      'http::GET::/api/c',
      'grpc::svc.Service/x',
      'grpc::svc.Service/y',
    ]);
  });
});

/**
 * A repo the sync reported unreadable contributes NO contracts to the persisted
 * registry — including through deferred manifest resolution.
 *
 * Per-repo staging (above) closes the extractor door only. It leaves the
 * manifest one open: `repoHandles` kept the failed repo's pool identity, so the
 * windowed manifest phase still counted it among the known repos, re-opened it,
 * and `ManifestExtractor` emitted a contract for BOTH endpoints of every link
 * naming it. contracts.json therefore listed a repo that the very same run's
 * `unreadableRepos` said it could not read — the contradiction the staging
 * change exists to remove, reproduced one phase later.
 *
 * The narrow part is what must NOT be dropped. `ManifestExtractor` resolves both
 * endpoints of a link and emits one contract per endpoint, so dropping the whole
 * link would also delete the HEALTHY partner's contract. A link is not the unit
 * of ownership; the endpoint is. Hence the filter is by endpoint repo, and the
 * all-healthy control below is what pins the healthy partner's output so an
 * over-broad "drop the link" fix cannot pass.
 *
 * Every assertion here reads the WRITTEN contracts.json, not the in-memory
 * `SyncResult`: the file is what `group status`, the bridge builder and the next
 * sync consume, so an in-memory-only assertion would not describe the artifact
 * the requirement is about.
 */

const GRPC_LINK: GroupManifestLink = {
  from: 'app/gateway',
  to: 'app/backend',
  type: 'grpc',
  // `role` describes `from`: the gateway CONSUMES what the backend provides, so
  // the provider endpoint is the repo whose extractor fails below.
  role: 'consumer',
  contract: 'orders.Orders/List',
};

const LINK_CONTRACT_ID = 'grpc::orders.Orders/List';

const linkedConfig = (): GroupConfig => ({
  ...config(),
  repos: { 'app/gateway': 'gateway-repo', 'app/backend': 'backend-repo' },
  links: [GRPC_LINK],
});

/**
 * Resolve handles from a table keyed on the GROUP path, so a two-repo case needs
 * no branching in the test body. Distinct `repoPath`s are what let the extractor
 * outcome below be keyed per repo.
 */
const LINKED_HANDLES = new Map<string, RepoHandle>([
  [
    'app/gateway',
    {
      id: 'pool-gateway',
      path: '/repos/gateway',
      repoPath: '/repos/gateway',
      storagePath: '/repos/gateway/.gitnexus',
    },
  ],
  [
    'app/backend',
    {
      id: 'pool-backend',
      path: '/repos/backend',
      repoPath: '/repos/backend',
      storagePath: '/repos/backend/.gitnexus',
    },
  ],
]);

const resolveLinkedHandle = async (
  _registryName: string,
  groupPath: string,
): Promise<RepoHandle | null> => LINKED_HANDLES.get(groupPath) ?? null;

/**
 * `extract(executor, repoPath, handle)` — key the outcome on the repo path so
 * which repo fails is data, not a branch in a test body. A repo outside the
 * failing set extracts cleanly.
 */
const grpcFailingIn =
  (failing: ReadonlySet<string>) =>
  async (_executor: unknown, repoPath: unknown): Promise<ExtractedContract[]> => {
    if (failing.has(String(repoPath))) throw new Error('gRPC extraction failed');
    return [];
  };

const readPersistedRegistry = (dir: string): ContractRegistry =>
  JSON.parse(fs.readFileSync(path.join(dir, 'contracts.json'), 'utf8')) as ContractRegistry;

/** `<repo>|<contractId>|<role>` — the identity a registry reader cares about. */
const contractIdentities = (registry: ContractRegistry): string[] =>
  registry.contracts.map((c) => `${c.repo}|${c.contractId}|${c.role}`);

describe('syncGroup persisting a manifest link with an unreadable endpoint', () => {
  let groupDir: string;

  beforeEach(() => {
    httpExtract.mockReset();
    grpcExtract.mockReset();
    // `mockClear`, not `mockReset` — the resolving implementation is what makes
    // `await initLbug(...)` a no-op for every other case in this file.
    initLbugMock.mockClear();
    // The manifest link is the only contract source in these cases, so the
    // per-repo extractors contribute nothing and the registry contains exactly
    // what deferred manifest resolution emitted.
    httpExtract.mockResolvedValue([]);
    groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sync-manifest-'));
  });

  afterEach(() => {
    fs.rmSync(groupDir, { recursive: true, force: true });
  });

  it('names no contract for the repo the same run reported unreadable', async () => {
    grpcExtract.mockImplementation(grpcFailingIn(new Set(['/repos/backend'])));

    const result = await syncGroup(linkedConfig(), {
      groupDir,
      resolveRepoHandle: resolveLinkedHandle,
    });

    expect(result.unreadableRepos).toEqual(['app/backend']);
    expect(result.registryOutcome).toBe('written');

    const onDisk = readPersistedRegistry(groupDir);
    expect(onDisk.unreadableRepos).toEqual(['app/backend']);
    expect(onDisk.contracts.filter((c) => c.repo === 'app/backend')).toEqual([]);
    // Not just the `repo` tag: the manifest fallback uid is `manifest::<repo>::…`,
    // so a contract can still carry the unreadable repo's name after a filter
    // that only looked at one field.
    expect(onDisk.contracts.filter((c) => JSON.stringify(c).includes('app/backend'))).toEqual([]);
  });

  it('keeps the healthy endpoint’s own contract from that same link', async () => {
    grpcExtract.mockImplementation(grpcFailingIn(new Set(['/repos/backend'])));

    await syncGroup(linkedConfig(), { groupDir, resolveRepoHandle: resolveLinkedHandle });

    // Byte-identical to the healthy endpoint's line in the all-healthy control
    // below — that equality IS the requirement: one endpoint failing costs the
    // other nothing. A fix that drops the whole link empties this array.
    expect(contractIdentities(readPersistedRegistry(groupDir))).toEqual([
      `app/gateway|${LINK_CONTRACT_ID}|consumer`,
    ]);
  });

  it('emits no cross-link for a pair whose other endpoint failed', async () => {
    grpcExtract.mockImplementation(grpcFailingIn(new Set(['/repos/backend'])));

    await syncGroup(linkedConfig(), { groupDir, resolveRepoHandle: resolveLinkedHandle });

    // A cross-link asserts a relationship between two repos. With one of them
    // absent from this sync there is nothing to assert it against, and a
    // half-anchored link is exactly the "confident about something it could not
    // read" answer the registry must not give.
    expect(readPersistedRegistry(groupDir).crossLinks).toEqual([]);
  });

  it('emits both contracts and the cross-link when both endpoints are healthy', async () => {
    // The control. Without it, "drop everything the link touches" passes every
    // case above while deleting a healthy repo's contracts.
    grpcExtract.mockImplementation(grpcFailingIn(new Set()));

    const result = await syncGroup(linkedConfig(), {
      groupDir,
      resolveRepoHandle: resolveLinkedHandle,
    });

    expect(result.unreadableRepos).toEqual([]);
    expect(result.registryOutcome).toBe('written');

    const onDisk = readPersistedRegistry(groupDir);
    expect(contractIdentities(onDisk)).toEqual([
      `app/backend|${LINK_CONTRACT_ID}|provider`,
      `app/gateway|${LINK_CONTRACT_ID}|consumer`,
    ]);
    expect(onDisk.crossLinks).toHaveLength(1);
    expect(onDisk.crossLinks[0]).toMatchObject({
      from: { repo: 'app/gateway' },
      to: { repo: 'app/backend' },
      type: 'grpc',
      contractId: LINK_CONTRACT_ID,
      matchType: 'manifest',
    });
  });

  it('does not re-open the index it just reported unreadable', async () => {
    // The other half of the fix, and the one a contract-level assertion cannot
    // see: the manifest phase derives its known-repo set from `repoHandles`, so
    // a failed repo left in that map is re-initialized and queried a second
    // time. Filtering the OUTPUT would still hide the contracts while the sync
    // went on reading an index it had already told the operator it could not
    // read — and, for a window at its residency cap, spending a slot on it.
    grpcExtract.mockImplementation(grpcFailingIn(new Set(['/repos/backend'])));

    await syncGroup(linkedConfig(), { groupDir, resolveRepoHandle: resolveLinkedHandle });

    const openedPools = initLbugMock.mock.calls.map((call) => String(call[0]));
    // The gateway is opened twice: once to extract, once for its manifest
    // window. The backend is opened once — the extraction attempt that failed —
    // and never again.
    expect(openedPools).toEqual(['pool-gateway', 'pool-backend', 'pool-gateway']);
  });

  it('tells the operator the endpoint was unreadable, not that it is unconfigured', async () => {
    // The two diagnoses need different actions: an unconfigured repo means edit
    // group.yaml, an unreadable one means re-index. Reusing the "not in
    // config.repos" line for a repo that IS configured sends the operator to
    // change a file that is already correct — and its "cross-links will use
    // synthetic UIDs" tail describes an outcome that no longer happens, since
    // this link's cross-link is dropped outright.
    grpcExtract.mockImplementation(grpcFailingIn(new Set(['/repos/backend'])));
    const cap = _captureLogger();

    try {
      await syncGroup(linkedConfig(), { groupDir, resolveRepoHandle: resolveLinkedHandle });
    } finally {
      cap.restore();
    }

    const linkWarnings = cap
      .records()
      .filter((r) => r.level === 40)
      .map((r) => String(r.msg ?? ''))
      .filter((msg) => msg.includes('[group/sync] manifest link'));

    expect(linkWarnings).toHaveLength(1);
    expect(linkWarnings[0]).toContain('could not read: app/backend');
    expect(linkWarnings[0]).not.toContain('not in config.repos');
  });
});
