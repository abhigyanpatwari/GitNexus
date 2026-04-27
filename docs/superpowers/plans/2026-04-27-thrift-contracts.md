# Thrift Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add open-source-safe Apache Thrift contract extraction to GitNexus group sync.

**Architecture:** Add `thrift` as a first-class group `ContractType`, with a `ThriftExtractor` that first parses `.thrift` IDL and then scans generic Java generated-code usage. Matching and manifest resolution follow existing gRPC patterns but stay framework-neutral and use fictional test fixtures only.

**Tech Stack:** TypeScript, Vitest, tree-sitter, tree-sitter-java, glob, GitNexus group sync pipeline.

---

## Rules And Validation

- Follow `AGENTS.md` and `GUARDRAILS.md`.
- Before modifying shared code symbols, run GitNexus impact analysis for the target symbol.
- Before each commit, run `detect_changes({ repo: "GitNexus", scope: "staged" })`.
- Do not add company-internal annotation names, appkeys, private package names, or real business snippets.
- Use fictional examples such as `billing.v1.OrderService/PlaceOrder`.

Implementation validation commands:

```bash
cd gitnexus && npx vitest run test/unit/group/thrift-extractor.test.ts test/unit/group/matching.test.ts test/unit/group/manifest-extractor.test.ts test/unit/group/config-parser.test.ts test/unit/group/types.test.ts test/unit/group/sync.test.ts
cd gitnexus && npx tsc --noEmit
cd gitnexus && npm test
```

## File Structure

- Modify `gitnexus/src/core/group/types.ts`: add `thrift` to `ContractType` and `DetectConfig`.
- Modify `gitnexus/src/core/group/config-parser.ts`: accept `thrift` manifest links and default `detect.thrift` to true.
- Modify `gitnexus/src/core/group/extractors/manifest-extractor.ts`: build and resolve thrift manifest contract IDs.
- Modify `gitnexus/src/core/group/matching.ts`: normalize thrift IDs and generalize service wildcard matching.
- Modify `gitnexus/src/core/group/sync.ts`: instantiate and run `ThriftExtractor`; merge wildcard matches after exact matching.
- Create `gitnexus/src/core/group/extractors/thrift-extractor.ts`: orchestrates IDL parsing and Java plugin detections.
- Create `gitnexus/src/core/group/extractors/thrift-patterns/types.ts`: shared plugin detection types.
- Create `gitnexus/src/core/group/extractors/thrift-patterns/index.ts`: file extension registry for thrift source scanners.
- Create `gitnexus/src/core/group/extractors/thrift-patterns/java.ts`: generic Java generated-code scanner.
- Create `gitnexus/test/unit/group/thrift-extractor.test.ts`: IDL and Java extraction tests.
- Modify existing group tests for types, config, manifest, matching, and sync.
- Add `docs/guides/microservices-thrift.md`: public guide using fictional examples only.

---

### Task 1: Add `thrift` To Core Types, Config, And Manifest

**Files:**
- Modify: `gitnexus/src/core/group/types.ts`
- Modify: `gitnexus/src/core/group/config-parser.ts`
- Modify: `gitnexus/src/core/group/extractors/manifest-extractor.ts`
- Test: `gitnexus/test/unit/group/types.test.ts`
- Test: `gitnexus/test/unit/group/config-parser.test.ts`
- Test: `gitnexus/test/unit/group/manifest-extractor.test.ts`

- [ ] **Step 1: Run impact analysis**

Run:

```bash
gitnexus impact ContractType --repo GitNexus --direction upstream
gitnexus impact parseGroupConfig --repo GitNexus --direction upstream
gitnexus impact ManifestExtractor --repo GitNexus --direction upstream
```

Expected: impact reports direct test and group pipeline dependents. If risk is HIGH or CRITICAL, stop and report it before editing.

- [ ] **Step 2: Write failing type and config tests**

Edit `gitnexus/test/unit/group/types.test.ts`:

```ts
it('ExtractedContract accepts thrift contract type', () => {
  const contract: ExtractedContract = {
    contractId: 'thrift::billing.v1.OrderService/PlaceOrder',
    type: 'thrift',
    role: 'provider',
    symbolUid: 'uid-thrift',
    symbolRef: { filePath: 'idl/order.thrift', name: 'OrderService.PlaceOrder' },
    symbolName: 'OrderService.PlaceOrder',
    confidence: 0.9,
    meta: {},
  };
  expect(contract.type).toBe('thrift');
});

it('DetectConfig includes thrift toggle', () => {
  const config: GroupConfig = {
    version: 1,
    name: 'company',
    description: 'All company microservices',
    repos: { orders: 'orders-repo' },
    links: [],
    packages: {},
    detect: {
      http: true,
      grpc: true,
      thrift: true,
      topics: true,
      shared_libs: true,
      embedding_fallback: true,
    },
    matching: { bm25_threshold: 0.7, embedding_threshold: 0.65, max_candidates_per_step: 3 },
  };
  expect(config.detect.thrift).toBe(true);
});
```

Edit `gitnexus/test/unit/group/config-parser.test.ts`:

```ts
it('defaults thrift detection to true', () => {
  const minimal = `
version: 1
name: test
repos:
  app: my-app
`;
  const config = parseGroupConfig(minimal);
  expect(config.detect.thrift).toBe(true);
});

it('parses thrift manifest links', () => {
  const yaml = `
version: 1
name: test
repos:
  gateway: gateway-repo
  orders: orders-repo
links:
  - from: gateway
    to: orders
    type: thrift
    contract: billing.v1.OrderService/PlaceOrder
    role: consumer
`;
  const config = parseGroupConfig(yaml);
  expect(config.links[0].type).toBe('thrift');
  expect(config.links[0].contract).toBe('billing.v1.OrderService/PlaceOrder');
});
```

Edit `gitnexus/test/unit/group/manifest-extractor.test.ts` and add:

```ts
it('builds thrift manifest contracts with synthetic uids when unresolved', async () => {
  const extractor = new ManifestExtractor();
  const result = await extractor.extractFromManifest([
    {
      from: 'gateway',
      to: 'orders',
      type: 'thrift',
      contract: 'billing.v1.OrderService/PlaceOrder',
      role: 'consumer',
    },
  ]);

  expect(result.contracts).toHaveLength(2);
  expect(result.contracts.map((c) => c.contractId)).toEqual([
    'thrift::billing.v1.OrderService/PlaceOrder',
    'thrift::billing.v1.OrderService/PlaceOrder',
  ]);
  expect(result.crossLinks).toHaveLength(1);
  expect(result.crossLinks[0].type).toBe('thrift');
  expect(result.crossLinks[0].from.symbolUid).toBe(
    'manifest::gateway::thrift::billing.v1.OrderService/PlaceOrder',
  );
  expect(result.crossLinks[0].to.symbolUid).toBe(
    'manifest::orders::thrift::billing.v1.OrderService/PlaceOrder',
  );
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
cd gitnexus && npx vitest run test/unit/group/types.test.ts test/unit/group/config-parser.test.ts test/unit/group/manifest-extractor.test.ts
```

Expected: TypeScript compile/test failures because `thrift` is not in `ContractType`, `DetectConfig.thrift` does not exist, and manifest `buildContractId` does not handle thrift.

- [ ] **Step 4: Implement core type/config/manifest support**

Edit `gitnexus/src/core/group/types.ts`:

```ts
export type ContractType = 'http' | 'grpc' | 'thrift' | 'topic' | 'lib' | 'custom';
```

Add `thrift` to `DetectConfig`:

```ts
export interface DetectConfig {
  http: boolean;
  grpc: boolean;
  thrift: boolean;
  topics: boolean;
  shared_libs: boolean;
  embedding_fallback: boolean;
}
```

Edit `gitnexus/src/core/group/config-parser.ts`:

```ts
const VALID_CONTRACT_TYPES: ContractType[] = ['http', 'grpc', 'thrift', 'topic', 'lib', 'custom'];
```

Add the default:

```ts
const DEFAULT_DETECT = {
  http: true,
  grpc: true,
  thrift: true,
  topics: true,
  shared_libs: true,
  embedding_fallback: true,
};
```

Edit `gitnexus/src/core/group/extractors/manifest-extractor.ts` in `resolveSymbol`:

```ts
      } else if (link.type === 'grpc' || link.type === 'thrift') {
        // Contract is "Service/Method" or just "Service" (or package.Service
        // variants). Prefer matching by method name when present, otherwise
        // by service name. NO IDL file fallback — that can attach to a wrong
        // symbol in repos with more than one interface file.
        const parts = link.contract.split('/');
        const serviceName = parts[0]?.trim().split('.').pop() ?? '';
        const methodName = parts[1]?.trim() ?? '';
        if (methodName) {
          rows = await executor(
            `MATCH (n:Function|Method) WHERE n.name = $methodName
             RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
             ORDER BY n.filePath ASC
             LIMIT 1`,
            { methodName },
          );
        } else if (serviceName) {
          rows = await executor(
            `MATCH (n:Class|Interface) WHERE n.name = $serviceName
             RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
             ORDER BY n.filePath ASC
             LIMIT 1`,
            { serviceName },
          );
        } else {
          rows = [];
        }
```

Edit `buildContractId` in the same file:

```ts
      case 'grpc':
        return `grpc::${contract}`;
      case 'thrift':
        return `thrift::${contract}`;
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
cd gitnexus && npx vitest run test/unit/group/types.test.ts test/unit/group/config-parser.test.ts test/unit/group/manifest-extractor.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run detect changes and commit**

Run:

```bash
git add gitnexus/src/core/group/types.ts gitnexus/src/core/group/config-parser.ts gitnexus/src/core/group/extractors/manifest-extractor.ts gitnexus/test/unit/group/types.test.ts gitnexus/test/unit/group/config-parser.test.ts gitnexus/test/unit/group/manifest-extractor.test.ts
```

Then run MCP `detect_changes({ repo: "GitNexus", scope: "staged" })`.

Commit:

```bash
git commit -m "feat(group): add thrift contract type"
```

---

### Task 2: Normalize Thrift Contracts And Wire Wildcard Matching

**Files:**
- Modify: `gitnexus/src/core/group/matching.ts`
- Modify: `gitnexus/src/core/group/sync.ts`
- Test: `gitnexus/test/unit/group/matching.test.ts`
- Test: `gitnexus/test/unit/group/sync.test.ts`

- [ ] **Step 1: Run impact analysis**

Run:

```bash
gitnexus impact normalizeContractId --repo GitNexus --direction upstream
gitnexus impact runExactMatch --repo GitNexus --direction upstream
gitnexus impact runWildcardMatch --repo GitNexus --direction upstream
gitnexus impact syncGroup --repo GitNexus --direction upstream
```

Expected: impact reports group matching and sync tests. Stop on HIGH or CRITICAL risk.

- [ ] **Step 2: Write failing matching tests**

Add helper in `gitnexus/test/unit/group/matching.test.ts`:

```ts
function makeThriftContract(
  id: string,
  role: 'provider' | 'consumer',
  repo: string,
  overrides: Partial<StoredContract> = {},
): StoredContract {
  return {
    contractId: id,
    type: 'thrift',
    role,
    symbolUid: `uid-${repo}-${id}`,
    symbolRef: { filePath: `src/${repo}.java`, name: `fn-${id}` },
    symbolName: `fn-${id}`,
    confidence: 0.8,
    meta: {},
    repo,
    ...overrides,
  };
}
```

Add tests:

```ts
it('lowercases thrift namespace and service but preserves method casing', () => {
  expect(normalizeContractId('thrift::Billing.V1.OrderService/PlaceOrder')).toBe(
    'thrift::billing.v1.orderservice/PlaceOrder',
  );
});

it('preserves malformed thrift id with leading slash', () => {
  expect(normalizeContractId('thrift::/PlaceOrder')).toBe('thrift::/PlaceOrder');
});
```

Add wildcard tests:

```ts
describe('runWildcardMatch — thrift', () => {
  it('matches thrift service wildcard to method provider', () => {
    const consumer = makeThriftContract('thrift::billing.v1.OrderService/*', 'consumer', 'gateway');
    const provider = makeThriftContract(
      'thrift::billing.v1.OrderService/PlaceOrder',
      'provider',
      'orders',
      { confidence: 0.9 },
    );

    const providerIndex = buildProviderIndex([provider]);
    const { matched, remaining } = runWildcardMatch([consumer], providerIndex);

    expect(matched).toHaveLength(1);
    expect(matched[0].type).toBe('thrift');
    expect(matched[0].contractId).toBe('thrift::billing.v1.OrderService/*');
    expect(matched[0].from.repo).toBe('gateway');
    expect(matched[0].to.repo).toBe('orders');
    expect(remaining).toHaveLength(0);
  });

  it('matches bare thrift service wildcard to package-qualified provider', () => {
    const consumer = makeThriftContract('thrift::OrderService/*', 'consumer', 'gateway');
    const provider = makeThriftContract(
      'thrift::billing.v1.OrderService/PlaceOrder',
      'provider',
      'orders',
    );

    const providerIndex = buildProviderIndex([provider]);
    const { matched } = runWildcardMatch([consumer], providerIndex);

    expect(matched).toHaveLength(1);
  });
});
```

Add a sync test in `gitnexus/test/unit/group/sync.test.ts`:

```ts
it('syncGroup adds wildcard cross-links after exact matching', async () => {
  const config = makeConfig({ gateway: 'gateway-repo', orders: 'orders-repo' });
  const mockContracts: StoredContract[] = [
    {
      contractId: 'thrift::billing.v1.OrderService/*',
      type: 'thrift',
      role: 'consumer',
      symbolUid: 'uid-gateway-thrift',
      symbolRef: { filePath: 'src/Gateway.java', name: 'OrderService' },
      symbolName: 'OrderService',
      confidence: 0.55,
      meta: {},
      repo: 'gateway',
    },
    {
      contractId: 'thrift::billing.v1.OrderService/PlaceOrder',
      type: 'thrift',
      role: 'provider',
      symbolUid: 'uid-orders-thrift',
      symbolRef: { filePath: 'idl/order.thrift', name: 'OrderService.PlaceOrder' },
      symbolName: 'OrderService.PlaceOrder',
      confidence: 0.85,
      meta: {},
      repo: 'orders',
    },
  ];

  const result = await syncGroup(config, {
    extractorOverride: async () => mockContracts,
    skipWrite: true,
  });

  expect(result.crossLinks).toHaveLength(1);
  expect(result.crossLinks[0].matchType).toBe('wildcard');
  expect(result.crossLinks[0].type).toBe('thrift');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
cd gitnexus && npx vitest run test/unit/group/matching.test.ts test/unit/group/sync.test.ts
```

Expected: thrift normalization and wildcard sync tests fail.

- [ ] **Step 4: Implement generalized wildcard logic**

Edit `gitnexus/src/core/group/matching.ts`:

```ts
function isServiceWildcard(cid: string): boolean {
  return (cid.startsWith('grpc::') || cid.startsWith('thrift::')) && cid.endsWith('/*');
}
```

Replace calls to `isGrpcWildcard` with `isServiceWildcard`.

Add thrift normalization in `normalizeContractId`:

```ts
    case 'grpc':
    case 'thrift': {
      const slashIdx = rest.indexOf('/');
      if (slashIdx > 0) {
        const svc = rest.substring(0, slashIdx).toLowerCase();
        const method = rest.substring(slashIdx);
        return `${type}::${svc}${method}`;
      }
      if (slashIdx === 0) {
        return `${type}::${rest}`;
      }
      return `${type}::${rest.toLowerCase()}`;
    }
```

Update comments in `runExactMatch` from gRPC-specific to service wildcard wording.

Update `runWildcardMatch` checks:

```ts
      if (
        !(key.startsWith('grpc::') || key.startsWith('thrift::')) ||
        key.endsWith('/*')
      ) {
        continue;
      }
      const keyType = key.slice(0, key.indexOf('::'));
      const consumerType = normalized.slice(0, normalized.indexOf('::'));
      if (keyType !== consumerType) continue;
```

Use `const afterPrefix = key.slice(key.indexOf('::') + 2);` instead of `key.slice(6)`.

Edit `gitnexus/src/core/group/sync.ts` imports:

```ts
import { buildProviderIndex, runExactMatch, runWildcardMatch } from './matching.js';
```

Replace matching block:

```ts
  const providerIndex = buildProviderIndex(autoContracts);
  const exact = runExactMatch(autoContracts, providerIndex);
  const wildcard = runWildcardMatch(exact.unmatched, providerIndex);
```

Replace cross-link and unmatched construction:

```ts
  const crossLinks = dedupeCrossLinks([
    ...manifestCrossLinks,
    ...exact.matched,
    ...wildcard.matched,
  ]);
  const unmatched = wildcard.remaining;
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
cd gitnexus && npx vitest run test/unit/group/matching.test.ts test/unit/group/sync.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run detect changes and commit**

Run:

```bash
git add gitnexus/src/core/group/matching.ts gitnexus/src/core/group/sync.ts gitnexus/test/unit/group/matching.test.ts gitnexus/test/unit/group/sync.test.ts
```

Then run MCP `detect_changes({ repo: "GitNexus", scope: "staged" })`.

Commit:

```bash
git commit -m "feat(group): match thrift service wildcards"
```

---

### Task 3: Add Thrift IDL Parser And Extractor Scaffold

**Files:**
- Create: `gitnexus/src/core/group/extractors/thrift-extractor.ts`
- Test: `gitnexus/test/unit/group/thrift-extractor.test.ts`

- [ ] **Step 1: Write failing IDL extraction tests**

Create `gitnexus/test/unit/group/thrift-extractor.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  ThriftExtractor,
  buildThriftContext,
  thriftMethodContractId,
  thriftServiceContractId,
} from '../../../src/core/group/extractors/thrift-extractor.js';
import type { RepoHandle } from '../../../src/core/group/types.js';

describe('ThriftExtractor', () => {
  let tmpDir: string;
  let extractor: ThriftExtractor;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-thrift-'));
    extractor = new ThriftExtractor();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(relPath: string, content: string): void {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  const makeRepo = (repoPath: string): RepoHandle => ({
    id: 'test-repo',
    path: 'test/app',
    repoPath,
    storagePath: path.join(repoPath, '.gitnexus'),
  });

  it('test_extract_thrift_service_single_method_returns_provider', async () => {
    writeFile(
      'idl/order.thrift',
      `namespace java billing.v1

struct PlaceOrderRequest {
  1: optional string orderId
}

service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    const providers = contracts.filter((c) => c.role === 'provider');

    expect(providers).toHaveLength(1);
    expect(providers[0].contractId).toBe('thrift::billing.v1.OrderService/PlaceOrder');
    expect(providers[0].confidence).toBe(0.85);
    expect(providers[0].symbolRef.filePath).toBe('idl/order.thrift');
    expect(providers[0].symbolName).toBe('OrderService.PlaceOrder');
  });

  it('test_extract_thrift_service_multiple_methods_returns_all', async () => {
    writeFile(
      'idl/order.thrift',
      `namespace java billing.v1
service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
  OrderStatus GetOrder(1: string orderId)
  list<OrderStatus> ListOrders(1: string userId)
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    expect(contracts.map((c) => c.contractId).sort()).toEqual([
      'thrift::billing.v1.OrderService/GetOrder',
      'thrift::billing.v1.OrderService/ListOrders',
      'thrift::billing.v1.OrderService/PlaceOrder',
    ]);
  });

  it('test_extract_thrift_without_java_namespace_uses_other_namespace', async () => {
    writeFile(
      'idl/order.thrift',
      `namespace py billing.v1
service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    expect(contracts[0].contractId).toBe('thrift::billing.v1.OrderService/PlaceOrder');
  });

  it('test_extract_thrift_without_namespace_uses_service_only', async () => {
    writeFile(
      'idl/order.thrift',
      `service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    expect(contracts[0].contractId).toBe('thrift::OrderService/PlaceOrder');
  });

  it('test_extract_thrift_ignores_braces_inside_comments_and_strings', async () => {
    writeFile(
      'idl/order.thrift',
      `namespace java billing.v1
service OrderService {
  // comment with { and }
  const string Example = "literal with { brace"
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
  OrderStatus GetOrder(1: string orderId)
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    expect(contracts.map((c) => c.symbolName).sort()).toEqual([
      'OrderService.GetOrder',
      'OrderService.PlaceOrder',
    ]);
  });

  it('test_extract_thrift_malformed_unclosed_service_skips_service', async () => {
    writeFile(
      'idl/broken.thrift',
      `namespace java billing.v1
service BrokenService {
  BrokenResponse Break(1: BrokenRequest request)
`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    expect(contracts).toHaveLength(0);
  });

  it('test_buildThriftContext_indexes_services_by_name', async () => {
    writeFile(
      'idl/order.thrift',
      `namespace java billing.v1
service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
    );

    const context = await buildThriftContext(tmpDir);
    expect(context.servicesByName.get('OrderService')?.[0]).toMatchObject({
      namespace: 'billing.v1',
      serviceName: 'OrderService',
      methods: ['PlaceOrder'],
      thriftPath: 'idl/order.thrift',
    });
  });

  it('test_contract_id_helpers', () => {
    expect(thriftMethodContractId('billing.v1', 'OrderService', 'PlaceOrder')).toBe(
      'thrift::billing.v1.OrderService/PlaceOrder',
    );
    expect(thriftServiceContractId('', 'OrderService')).toBe('thrift::OrderService/*');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd gitnexus && npx vitest run test/unit/group/thrift-extractor.test.ts
```

Expected: FAIL because `thrift-extractor.ts` does not exist.

- [ ] **Step 3: Implement IDL-only extractor**

Create `gitnexus/src/core/group/extractors/thrift-extractor.ts`:

```ts
import * as path from 'node:path';
import { glob } from 'glob';
import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../types.js';
import { readSafe } from './fs-utils.js';

export interface ThriftServiceInfo {
  namespace: string;
  serviceName: string;
  methods: string[];
  thriftPath: string;
}

export interface ThriftContext {
  servicesByName: Map<string, ThriftServiceInfo[]>;
}

export function thriftMethodContractId(
  namespace: string,
  serviceName: string,
  methodName: string,
): string {
  const prefix = namespace ? `${namespace}.${serviceName}` : serviceName;
  return `thrift::${prefix}/${methodName}`;
}

export function thriftServiceContractId(namespace: string, serviceName: string): string {
  const prefix = namespace ? `${namespace}.${serviceName}` : serviceName;
  return `thrift::${prefix}/*`;
}

function normalizeThriftPath(rel: string): string {
  return rel.replace(/\\/g, '/');
}

function stripThriftCommentsAndStrings(content: string): string {
  const out = new Array<string>(content.length);
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    const next = content[i + 1];
    if (ch === '/' && next === '/') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < content.length && content[i] !== '\n') {
        out[i] = content[i] === '\r' ? '\r' : ' ';
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < content.length) {
        if (content[i] === '*' && content[i + 1] === '/') {
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 2;
          break;
        }
        out[i] = content[i] === '\n' || content[i] === '\r' ? content[i] : ' ';
        i++;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out[i] = ' ';
      i++;
      while (i < content.length) {
        const c = content[i];
        if (c === '\\' && i + 1 < content.length) {
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (c === quote) {
          out[i] = ' ';
          i++;
          break;
        }
        out[i] = c === '\n' || c === '\r' ? c : ' ';
        i++;
      }
      continue;
    }
    out[i] = ch;
    i++;
  }
  return out.join('');
}

function selectNamespace(content: string): string {
  const namespaces: Array<{ lang: string; value: string }> = [];
  const re = /^\s*namespace\s+(\w+)\s+([A-Za-z_][\w.]*)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    namespaces.push({ lang: match[1], value: match[2] });
  }
  return namespaces.find((n) => n.lang === 'java')?.value ?? namespaces[0]?.value ?? '';
}

function extractServiceBlocks(content: string): Array<{ name: string; body: string }> {
  const results: Array<{ name: string; body: string }> = [];
  const sanitized = stripThriftCommentsAndStrings(content);
  const headerRe = /service\s+(\w+)\s*(?:extends\s+\w+\s*)?\{/g;
  let headerMatch: RegExpExecArray | null;
  while ((headerMatch = headerRe.exec(sanitized)) !== null) {
    const serviceName = headerMatch[1];
    const bodyStart = headerMatch.index + headerMatch[0].length;
    let depth = 1;
    let pos = bodyStart;
    while (pos < sanitized.length && depth > 0) {
      const ch = sanitized[pos];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      pos++;
    }
    if (depth !== 0) continue;
    results.push({ name: serviceName, body: content.slice(bodyStart, pos - 1) });
  }
  return results;
}

function extractMethods(serviceBody: string): string[] {
  const sanitized = stripThriftCommentsAndStrings(serviceBody);
  const methods: string[] = [];
  const lineRe = /^\s*(?:oneway\s+)?[\w.<>,\s]+?\s+(\w+)\s*\(/gm;
  let match: RegExpExecArray | null;
  while ((match = lineRe.exec(sanitized)) !== null) {
    const name = match[1];
    if (name !== 'throws') methods.push(name);
  }
  return methods;
}

function makeContract(
  cid: string,
  role: 'provider' | 'consumer',
  filePath: string,
  symbolName: string,
  confidence: number,
  meta: Record<string, unknown>,
): ExtractedContract {
  return {
    contractId: cid,
    type: 'thrift',
    role,
    symbolUid: '',
    symbolRef: { filePath: filePath.replace(/\\/g, '/'), name: symbolName },
    symbolName,
    confidence,
    meta: { ...meta, extractionStrategy: 'source_scan' },
  };
}

export async function buildThriftContext(repoPath: string): Promise<ThriftContext> {
  const servicesByName = new Map<string, ThriftServiceInfo[]>();
  const thriftFiles = await glob('**/*.thrift', {
    cwd: repoPath,
    absolute: false,
    nodir: true,
    ignore: ['**/node_modules/**', '**/.git/**', '**/vendor/**', '**/dist/**', '**/build/**'],
  });

  for (const rel of thriftFiles) {
    const normalizedRel = normalizeThriftPath(rel);
    const content = readSafe(repoPath, rel);
    if (!content) continue;
    const namespace = selectNamespace(content);
    for (const block of extractServiceBlocks(content)) {
      const info: ThriftServiceInfo = {
        namespace,
        serviceName: block.name,
        methods: extractMethods(block.body),
        thriftPath: normalizedRel,
      };
      const existing = servicesByName.get(block.name) ?? [];
      existing.push(info);
      servicesByName.set(block.name, existing);
    }
  }

  return { servicesByName };
}

export class ThriftExtractor implements ContractExtractor {
  type = 'thrift' as const;

  async canExtract(_repo: RepoHandle): Promise<boolean> {
    return true;
  }

  async extract(
    _dbExecutor: CypherExecutor | null,
    repoPath: string,
    _repo: RepoHandle,
  ): Promise<ExtractedContract[]> {
    const out: ExtractedContract[] = [];
    const context = await buildThriftContext(repoPath);

    for (const infos of context.servicesByName.values()) {
      for (const info of infos) {
        for (const methodName of info.methods) {
          out.push(
            makeContract(
              thriftMethodContractId(info.namespace, info.serviceName, methodName),
              'provider',
              info.thriftPath,
              `${info.serviceName}.${methodName}`,
              0.85,
              {
                namespace: info.namespace,
                service: info.serviceName,
                method: methodName,
                source: 'thrift_idl',
              },
            ),
          );
        }
      }
    }

    return this.dedupe(out);
  }

  private dedupe(items: ExtractedContract[]): ExtractedContract[] {
    const byKey = new Map<string, ExtractedContract>();
    for (const c of items) {
      const k = `${c.contractId}|${c.role}|${c.symbolRef.filePath}|${c.symbolName}`;
      const existing = byKey.get(k);
      if (!existing || c.confidence > existing.confidence) byKey.set(k, c);
    }
    return Array.from(byKey.values());
  }
}
```

- [ ] **Step 4: Run IDL tests**

Run:

```bash
cd gitnexus && npx vitest run test/unit/group/thrift-extractor.test.ts
```

Expected: IDL tests pass.

- [ ] **Step 5: Run detect changes and commit**

Run:

```bash
git add gitnexus/src/core/group/extractors/thrift-extractor.ts gitnexus/test/unit/group/thrift-extractor.test.ts
```

Then run MCP `detect_changes({ repo: "GitNexus", scope: "staged" })`.

Commit:

```bash
git commit -m "feat(group): extract thrift idl contracts"
```

---

### Task 4: Add Generic Java Thrift Source Scanner

**Files:**
- Create: `gitnexus/src/core/group/extractors/thrift-patterns/types.ts`
- Create: `gitnexus/src/core/group/extractors/thrift-patterns/index.ts`
- Create: `gitnexus/src/core/group/extractors/thrift-patterns/java.ts`
- Modify: `gitnexus/src/core/group/extractors/thrift-extractor.ts`
- Test: `gitnexus/test/unit/group/thrift-extractor.test.ts`

- [ ] **Step 1: Run impact analysis**

Run:

```bash
gitnexus impact ThriftExtractor --repo GitNexus --direction upstream
```

Expected: low impact because the extractor is new.

- [ ] **Step 2: Add failing Java scanner tests**

Append to `gitnexus/test/unit/group/thrift-extractor.test.ts`:

```ts
describe('java source scan', () => {
  it('test_java_provider_implements_iface_uses_method_contract', async () => {
    writeFile(
      'idl/order.thrift',
      `namespace java billing.v1
service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
    );
    writeFile(
      'src/OrderServiceImpl.java',
      `package example;
public class OrderServiceImpl implements OrderService.Iface {
  @Override
  public PlaceOrderResponse PlaceOrder(PlaceOrderRequest request) {
    return new PlaceOrderResponse();
  }
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    const provider = contracts.find((c) => c.meta.source === 'java_thrift_provider');

    expect(provider?.contractId).toBe('thrift::billing.v1.OrderService/PlaceOrder');
    expect(provider?.symbolRef.filePath).toBe('src/OrderServiceImpl.java');
    expect(provider?.symbolName).toBe('OrderService.PlaceOrder');
  });

  it('test_java_provider_implements_service_type_uses_method_contract', async () => {
    writeFile(
      'idl/order.thrift',
      `namespace java billing.v1
service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
    );
    writeFile(
      'src/OrderServiceImpl.java',
      `package example;
public class OrderServiceImpl implements OrderService {
  public PlaceOrderResponse PlaceOrder(PlaceOrderRequest request) {
    return new PlaceOrderResponse();
  }
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    const provider = contracts.find((c) => c.meta.source === 'java_thrift_provider');

    expect(provider?.contractId).toBe('thrift::billing.v1.OrderService/PlaceOrder');
  });

  it('test_java_consumer_iface_field_method_call_uses_method_contract', async () => {
    writeFile(
      'idl/order.thrift',
      `namespace java billing.v1
service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
    );
    writeFile(
      'src/Gateway.java',
      `package example;
public class Gateway {
  private OrderService.Iface orderService;
  public void submit(PlaceOrderRequest request) throws Exception {
    orderService.PlaceOrder(request);
  }
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    const consumer = contracts.find((c) => c.meta.source === 'java_thrift_consumer');

    expect(consumer?.contractId).toBe('thrift::billing.v1.OrderService/PlaceOrder');
    expect(consumer?.role).toBe('consumer');
    expect(consumer?.symbolRef.filePath).toBe('src/Gateway.java');
  });

  it('test_java_consumer_client_field_method_call_uses_method_contract', async () => {
    writeFile(
      'idl/order.thrift',
      `namespace java billing.v1
service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
    );
    writeFile(
      'src/Gateway.java',
      `package example;
public class Gateway {
  private OrderService.Client orderClient;
  public void submit(PlaceOrderRequest request) throws Exception {
    orderClient.PlaceOrder(request);
  }
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    const consumer = contracts.find((c) => c.meta.source === 'java_thrift_consumer');

    expect(consumer?.contractId).toBe('thrift::billing.v1.OrderService/PlaceOrder');
  });

  it('test_java_consumer_service_type_field_method_call_uses_method_contract', async () => {
    writeFile(
      'idl/order.thrift',
      `namespace java billing.v1
service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
    );
    writeFile(
      'src/Gateway.java',
      `package example;
public class Gateway {
  private OrderService orderService;
  public void submit(PlaceOrderRequest request) throws Exception {
    orderService.PlaceOrder(request);
  }
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    const consumer = contracts.find((c) => c.meta.source === 'java_thrift_consumer');

    expect(consumer?.contractId).toBe('thrift::billing.v1.OrderService/PlaceOrder');
  });

  it('test_java_consumer_without_idl_emits_weak_method_contract', async () => {
    writeFile(
      'src/Gateway.java',
      `package example;
public class Gateway {
  private OrderService orderService;
  public void submit(PlaceOrderRequest request) throws Exception {
    orderService.PlaceOrder(request);
  }
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    const consumer = contracts.find((c) => c.meta.source === 'java_thrift_consumer_weak');

    expect(consumer?.contractId).toBe('thrift::OrderService/PlaceOrder');
    expect(consumer?.confidence).toBe(0.45);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
cd gitnexus && npx vitest run test/unit/group/thrift-extractor.test.ts
```

Expected: Java scanner tests fail because no `thrift-patterns` plugin exists.

- [ ] **Step 4: Add plugin shared types and registry**

Create `gitnexus/src/core/group/extractors/thrift-patterns/types.ts`:

```ts
import type Parser from 'tree-sitter';

export type ThriftRole = 'provider' | 'consumer';

export interface ThriftDetection {
  role: ThriftRole;
  serviceName: string;
  symbolName: string;
  source: string;
  methodName?: string;
  confidenceWithIdl: number;
  confidenceWithoutIdl: number;
}

export interface ThriftLanguagePlugin {
  name: string;
  language: unknown;
  scan(tree: Parser.Tree): ThriftDetection[];
}
```

Create `gitnexus/src/core/group/extractors/thrift-patterns/index.ts`:

```ts
import * as path from 'node:path';
import type { ThriftLanguagePlugin } from './types.js';
import { JAVA_THRIFT_PLUGIN } from './java.js';

export type { ThriftDetection, ThriftLanguagePlugin, ThriftRole } from './types.js';

const REGISTRY: Record<string, ThriftLanguagePlugin> = {
  '.java': JAVA_THRIFT_PLUGIN,
};

export const THRIFT_SCAN_GLOB = '**/*.java';

export function getPluginForFile(rel: string): ThriftLanguagePlugin | undefined {
  const ext = path.extname(rel).toLowerCase();
  return REGISTRY[ext];
}
```

- [ ] **Step 5: Add Java plugin**

Create `gitnexus/src/core/group/extractors/thrift-patterns/java.ts`:

```ts
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import {
  compilePatterns,
  runCompiledPatterns,
  type LanguagePatterns,
} from '../tree-sitter-scanner.js';
import type { ThriftDetection, ThriftLanguagePlugin } from './types.js';

const IMPLEMENTS_PATTERNS = compilePatterns({
  name: 'java-thrift-implements',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (class_declaration
          name: (identifier) @class_name
          interfaces: (super_interfaces
            [
              (type_identifier) @iface
              (scoped_type_identifier
                (type_identifier) @iface_outer
                (type_identifier) @iface_inner)
            ])) @class
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

const FIELD_PATTERNS = compilePatterns({
  name: 'java-thrift-fields',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (field_declaration
          type: [
            (type_identifier) @type
            (scoped_type_identifier
              (type_identifier) @type_outer
              (type_identifier) @type_inner)
          ]
          declarator: (variable_declarator name: (identifier) @var))
      `,
    },
    {
      meta: {},
      query: `
        (local_variable_declaration
          type: [
            (type_identifier) @type
            (scoped_type_identifier
              (type_identifier) @type_outer
              (type_identifier) @type_inner)
          ]
          declarator: (variable_declarator name: (identifier) @var))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

const METHOD_INVOCATION_PATTERNS = compilePatterns({
  name: 'java-thrift-method-invocation',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (method_invocation
          object: (identifier) @receiver
          name: (identifier) @method)
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

function serviceNameFromType(outer?: string, inner?: string, simple?: string): string | null {
  if (outer && (inner === 'Iface' || inner === 'Client')) return outer;
  if (simple && /^[A-Z]\w*(Service|Management)$/.test(simple)) return simple;
  return null;
}

function collectMethodNames(classNode: Parser.SyntaxNode): Set<string> {
  const names = new Set<string>();
  const stack: Parser.SyntaxNode[] = [classNode];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'method_declaration') {
      const name = node.childForFieldName('name');
      if (name) names.add(name.text);
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
  return names;
}

export const JAVA_THRIFT_PLUGIN: ThriftLanguagePlugin = {
  name: 'java-thrift',
  language: Java,
  scan(tree) {
    const out: ThriftDetection[] = [];

    for (const match of runCompiledPatterns(IMPLEMENTS_PATTERNS, tree)) {
      const classNode = match.captures.class;
      if (!classNode) continue;
      const serviceName = serviceNameFromType(
        match.captures.iface_outer?.text,
        match.captures.iface_inner?.text,
        match.captures.iface?.text,
      );
      if (!serviceName) continue;
      for (const methodName of collectMethodNames(classNode)) {
        out.push({
          role: 'provider',
          serviceName,
          methodName,
          symbolName: `${serviceName}.${methodName}`,
          source: 'java_thrift_provider',
          confidenceWithIdl: 0.8,
          confidenceWithoutIdl: 0.5,
        });
      }
    }

    const receiverToService = new Map<string, string>();
    for (const match of runCompiledPatterns(FIELD_PATTERNS, tree)) {
      const receiver = match.captures.var?.text;
      if (!receiver) continue;
      const serviceName = serviceNameFromType(
        match.captures.type_outer?.text,
        match.captures.type_inner?.text,
        match.captures.type?.text,
      );
      if (serviceName) receiverToService.set(receiver, serviceName);
    }

    for (const match of runCompiledPatterns(METHOD_INVOCATION_PATTERNS, tree)) {
      const receiver = match.captures.receiver?.text;
      const methodName = match.captures.method?.text;
      if (!receiver || !methodName) continue;
      const serviceName = receiverToService.get(receiver);
      if (!serviceName) continue;
      out.push({
        role: 'consumer',
        serviceName,
        methodName,
        symbolName: `${serviceName}.${methodName}`,
        source: 'java_thrift_consumer',
        confidenceWithIdl: 0.75,
        confidenceWithoutIdl: 0.45,
      });
    }

    return out;
  },
};
```

- [ ] **Step 6: Wire plugin into `ThriftExtractor`**

Edit `gitnexus/src/core/group/extractors/thrift-extractor.ts` imports:

```ts
import Parser from 'tree-sitter';
import {
  THRIFT_SCAN_GLOB,
  getPluginForFile,
  type ThriftDetection,
} from './thrift-patterns/index.js';
```

Add helpers:

```ts
function resolveThriftService(
  serviceName: string,
  sourceFilePath: string,
  candidates: ThriftServiceInfo[],
): ThriftServiceInfo | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const normalizedSource = sourceFilePath.replace(/\\/g, '/');
  const sourceDir = path.dirname(normalizedSource);
  const scored = candidates.map((candidate) => {
    const thriftDir = path.dirname(candidate.thriftPath);
    const shared = sourceDir
      .split('/')
      .filter(Boolean)
      .filter((part) => thriftDir.split('/').includes(part)).length;
    return { candidate, score: shared };
  });
  const maxScore = Math.max(...scored.map((s) => s.score));
  const winners = scored.filter((s) => s.score === maxScore);
  return winners.length === 1 ? winners[0].candidate : null;
}

function detectionToContract(
  d: ThriftDetection,
  filePath: string,
  context: ThriftContext,
): ExtractedContract | null {
  const candidates = context.servicesByName.get(d.serviceName) ?? [];
  const info = resolveThriftService(d.serviceName, filePath, candidates);
  if (candidates.length > 0 && !info) return null;
  const hasIdl = Boolean(info);
  const knownMethod = info?.methods.includes(d.methodName ?? '') ?? false;
  const methodName = d.methodName;
  const cid =
    methodName && (knownMethod || candidates.length === 0)
      ? thriftMethodContractId(info?.namespace ?? '', d.serviceName, methodName)
      : thriftServiceContractId(info?.namespace ?? '', d.serviceName);
  const source =
    hasIdl || d.role === 'provider' ? d.source : `${d.source}_weak`;
  return makeContract(
    cid,
    d.role,
    filePath,
    d.symbolName,
    hasIdl ? d.confidenceWithIdl : d.confidenceWithoutIdl,
    {
      namespace: info?.namespace ?? '',
      service: d.serviceName,
      method: methodName,
      source,
    },
  );
}
```

In `extract`, after IDL providers are emitted:

```ts
    const sourceFiles = await glob(THRIFT_SCAN_GLOB, {
      cwd: repoPath,
      ignore: ['**/node_modules/**', '**/.git/**', '**/vendor/**', '**/dist/**', '**/build/**'],
      nodir: true,
    });

    const parser = new Parser();
    for (const rel of sourceFiles) {
      const plugin = getPluginForFile(rel);
      if (!plugin) continue;
      const content = readSafe(repoPath, rel);
      if (!content) continue;
      try {
        parser.setLanguage(plugin.language);
        const tree = parser.parse(content);
        for (const d of plugin.scan(tree)) {
          const contract = detectionToContract(d, rel, context);
          if (contract) out.push(contract);
        }
      } catch {
        continue;
      }
    }
```

- [ ] **Step 7: Run tests to verify they pass**

Run:

```bash
cd gitnexus && npx vitest run test/unit/group/thrift-extractor.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run detect changes and commit**

Run:

```bash
git add gitnexus/src/core/group/extractors/thrift-extractor.ts gitnexus/src/core/group/extractors/thrift-patterns/types.ts gitnexus/src/core/group/extractors/thrift-patterns/index.ts gitnexus/src/core/group/extractors/thrift-patterns/java.ts gitnexus/test/unit/group/thrift-extractor.test.ts
```

Then run MCP `detect_changes({ repo: "GitNexus", scope: "staged" })`.

Commit:

```bash
git commit -m "feat(group): detect java thrift usage"
```

---

### Task 5: Wire Thrift Extractor Into Group Sync

**Files:**
- Modify: `gitnexus/src/core/group/sync.ts`
- Test: `gitnexus/test/unit/group/sync.test.ts`

- [ ] **Step 1: Run impact analysis**

Run:

```bash
gitnexus impact syncGroup --repo GitNexus --direction upstream
```

Expected: direct impact on group tests and CLI/MCP group sync flows. Stop on HIGH or CRITICAL risk.

- [ ] **Step 2: Add failing sync extractor wiring test**

Add to `gitnexus/test/unit/group/sync.test.ts`:

```ts
it('syncGroup runs thrift extractor when detect.thrift is enabled', async () => {
  const config = makeConfig({ app: 'app-repo' });
  config.detect.http = false;
  config.detect.grpc = false;
  config.detect.thrift = true;
  config.detect.topics = false;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sync-thrift-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'idl'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'idl', 'order.thrift'),
      `namespace java billing.v1
service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
    );

    const result = await syncGroup(config, {
      resolveRepoHandle: async (_name, groupPath) => ({
        id: `test-${groupPath}`,
        path: groupPath,
        repoPath: tmpDir,
        storagePath: path.join(tmpDir, '.gitnexus'),
      }),
      skipWrite: true,
    });

    expect(result.contracts.some((c) => c.type === 'thrift')).toBe(true);
    expect(result.contracts[0].contractId).toBe('thrift::billing.v1.OrderService/PlaceOrder');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run:

```bash
cd gitnexus && npx vitest run test/unit/group/sync.test.ts
```

Expected: FAIL because `syncGroup` does not instantiate or call `ThriftExtractor`.

- [ ] **Step 4: Implement sync wiring**

Edit `gitnexus/src/core/group/sync.ts` imports:

```ts
import { ThriftExtractor } from './extractors/thrift-extractor.js';
```

Instantiate next to gRPC:

```ts
    const grpcEx = new GrpcExtractor();
    const thriftEx = new ThriftExtractor();
    const topicEx = new TopicExtractor();
```

Run it after gRPC:

```ts
          if (config.detect.thrift) {
            const extracted = await thriftEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }
```

- [ ] **Step 5: Run sync tests**

Run:

```bash
cd gitnexus && npx vitest run test/unit/group/sync.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run detect changes and commit**

Run:

```bash
git add gitnexus/src/core/group/sync.ts gitnexus/test/unit/group/sync.test.ts
```

Then run MCP `detect_changes({ repo: "GitNexus", scope: "staged" })`.

Commit:

```bash
git commit -m "feat(group): run thrift extractor in group sync"
```

---

### Task 6: Add Public Thrift Microservices Guide

**Files:**
- Create: `docs/guides/microservices-thrift.md`

- [ ] **Step 1: Write the guide**

Create `docs/guides/microservices-thrift.md`:

````md
# Using GitNexus across Thrift microservices

## When to use this guide

Use this guide when services communicate through Apache Thrift IDL and generated clients or service interfaces. GitNexus extracts thrift contracts during group sync, matches consumers to providers, and writes cross-links to the group's `contracts.json`.

## Mental model

- `.thrift` IDL files define canonical service and method contracts.
- Java generated-code usage can point contracts at implementation and call-site files.
- Contract IDs use `thrift::<namespace>.<Service>/<Method>`.
- Service-level fallbacks use `thrift::<namespace>.<Service>/*`.
- Framework-specific wiring belongs outside the open-source core. The extractor looks at generic Thrift service names, generated interfaces, and method calls.

## Example IDL

```thrift
namespace java billing.v1

service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
  OrderStatus GetOrder(1: string orderId)
}
```

Provider contract IDs:

```text
thrift::billing.v1.OrderService/PlaceOrder
thrift::billing.v1.OrderService/GetOrder
```

## Java patterns

Provider:

```java
public class OrderServiceImpl implements OrderService.Iface {
  @Override
  public PlaceOrderResponse PlaceOrder(PlaceOrderRequest request) {
    return new PlaceOrderResponse();
  }
}
```

Consumer:

```java
public class CheckoutGateway {
  private OrderService.Iface orderService;

  public void submit(PlaceOrderRequest request) throws Exception {
    orderService.PlaceOrder(request);
  }
}
```

Consumer with generated service type:

```java
public class CheckoutGateway {
  private OrderService orderService;

  public void submit(PlaceOrderRequest request) throws Exception {
    orderService.PlaceOrder(request);
  }
}
```

## Group config

```yaml
version: 1
name: commerce-platform
repos:
  gateway: checkout-gateway
  orders: orders-service
links: []
detect:
  http: true
  grpc: true
  thrift: true
  topics: true
  shared_libs: true
  embedding_fallback: false
matching:
  bm25_threshold: 0.7
  embedding_threshold: 0.65
  max_candidates_per_step: 3
```

## Manifest escape hatch

Use manifest links when automatic extraction cannot infer a connection:

```yaml
links:
  - from: gateway
    to: orders
    type: thrift
    contract: billing.v1.OrderService/PlaceOrder
    role: consumer
```

## Known limitations

- Source scanning supports Java v1 patterns only.
- Maven dependency coordinates are not used to infer contracts.
- Framework-specific annotations and service discovery rules are ignored.
- Ambiguous same-name services are skipped instead of guessed.
- If a consumer repo has no IDL, GitNexus can emit a lower-confidence contract from the Java type and method name.
````

- [ ] **Step 2: Verify no private names are present**

Run:

```bash
rg -n "CompanyInternalAnnotation|CompanyInternalPackage|RealBusinessService|RealServiceDiscoveryKey" docs/guides/microservices-thrift.md
```

Expected: no output.

- [ ] **Step 3: Run detect changes and commit**

Run:

```bash
git add docs/guides/microservices-thrift.md
```

Then run MCP `detect_changes({ repo: "GitNexus", scope: "staged" })`.

Commit:

```bash
git commit -m "docs(group): add thrift microservices guide"
```

---

### Task 7: Full Validation

**Files:**
- No new files

- [ ] **Step 1: Run focused tests**

Run:

```bash
cd gitnexus && npx vitest run test/unit/group/thrift-extractor.test.ts test/unit/group/matching.test.ts test/unit/group/manifest-extractor.test.ts test/unit/group/config-parser.test.ts test/unit/group/types.test.ts test/unit/group/sync.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
cd gitnexus && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Run full CLI/Core test suite**

Run:

```bash
cd gitnexus && npm test
```

Expected: PASS. If integration tests fail because of known LadybugDB file-locking in the local container, capture the failing test names and rerun the focused unit tests plus `npx tsc --noEmit`.

- [ ] **Step 4: Run private-repo smoke validation without committing private data**

Run group sync locally against a disposable group that includes a consumer repo with generic Java Thrift calls and a provider repo with matching `.thrift`/implementation. Inspect `contracts.json` manually for fictional/open-source code only before sharing any output.

Expected:

- Consumer call using a field typed as `OrderService` emits `thrift::OrderService/PlaceOrder` or namespace-qualified equivalent.
- Provider IDL emits `thrift::<namespace>.OrderService/PlaceOrder`.
- No private snippets are copied into GitNexus.

- [ ] **Step 5: Final detect changes**

Run MCP:

```text
detect_changes({ repo: "GitNexus", scope: "all" })
```

Expected: changed symbols match the thrift extractor, matching, sync, manifest/config/types, tests, and public docs only.

- [ ] **Step 6: Prepare PR summary**

Use this PR title:

```text
feat(group): add thrift contract extraction
```

PR body:

```md
## What

- Adds `thrift` as a group contract type.
- Extracts provider contracts from `.thrift` IDL.
- Detects generic Java Apache Thrift provider and consumer patterns.
- Matches thrift service wildcards to method-level providers.
- Documents Thrift microservice group usage with fictional examples.

## Why

Group contract sync previously supported HTTP, gRPC, and topics, but not Apache Thrift microservice calls.

## Verification

- `cd gitnexus && npx vitest run test/unit/group/thrift-extractor.test.ts test/unit/group/matching.test.ts test/unit/group/manifest-extractor.test.ts test/unit/group/config-parser.test.ts test/unit/group/types.test.ts test/unit/group/sync.test.ts`
- `cd gitnexus && npx tsc --noEmit`
- `cd gitnexus && npm test`

## Risk

- Changes group contract extraction and matching only.
- Java scanner is conservative and ignores framework-specific annotations.
- Wildcard matching is generalized from gRPC to gRPC + Thrift.
```
