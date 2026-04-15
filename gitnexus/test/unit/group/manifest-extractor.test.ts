import { describe, it, expect } from 'vitest';
import { ManifestExtractor } from '../../../src/core/group/extractors/manifest-extractor.js';
import type { GroupManifestLink } from '../../../src/core/group/types.js';

describe('ManifestExtractor', () => {
  const extractor = new ManifestExtractor();

  it('creates provider + consumer contracts and a cross-link for each manifest link', async () => {
    const links: GroupManifestLink[] = [
      {
        from: 'hr/payroll/backend',
        to: 'hr/hiring/backend',
        type: 'topic',
        contract: 'employee.hired',
        role: 'provider',
      },
    ];

    const result = await extractor.extractFromManifest(links);

    expect(result.contracts).toHaveLength(2);

    const provider = result.contracts.find((c) => c.role === 'provider');
    expect(provider).toBeDefined();
    expect(provider!.contractId).toBe('topic::employee.hired');
    expect(provider!.type).toBe('topic');
    expect(provider!.confidence).toBe(1.0);

    const consumer = result.contracts.find((c) => c.role === 'consumer');
    expect(consumer).toBeDefined();
    expect(consumer!.contractId).toBe('topic::employee.hired');

    expect(result.crossLinks).toHaveLength(1);
    expect(result.crossLinks[0].matchType).toBe('manifest');
    expect(result.crossLinks[0].confidence).toBe(1.0);
    expect(result.crossLinks[0].from.repo).toBe('hr/hiring/backend');
    expect(result.crossLinks[0].to.repo).toBe('hr/payroll/backend');
  });

  it('handles role: consumer (from-repo is consumer)', async () => {
    const links: GroupManifestLink[] = [
      {
        from: 'sales/admin/bff',
        to: 'sales/crm/backend',
        type: 'http',
        contract: '/api/v2/leads/*',
        role: 'consumer',
      },
    ];

    const result = await extractor.extractFromManifest(links);

    const provider = result.contracts.find((c) => c.role === 'provider');
    const consumer = result.contracts.find((c) => c.role === 'consumer');

    expect(consumer!.contractId).toBe('http::*::/api/v2/leads/*');
    expect(provider!.contractId).toBe('http::*::/api/v2/leads/*');

    expect(result.crossLinks[0].from.repo).toBe('sales/admin/bff');
    expect(result.crossLinks[0].to.repo).toBe('sales/crm/backend');
  });

  it('resolves grpc manifest provider by exact method name (no .proto fallback)', async () => {
    const links: GroupManifestLink[] = [
      {
        from: 'platform/orders',
        to: 'platform/auth',
        type: 'grpc',
        contract: 'auth.AuthService/Login',
        role: 'consumer',
      },
    ];

    const dbExecutors = new Map<
      string,
      (cypher: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>
    >([
      [
        'platform/auth',
        async (_cypher, params) => {
          // Exact match on method name.
          if (params?.methodName === 'Login') {
            return [
              {
                uid: 'uid-auth-login',
                name: 'Login',
                filePath: 'src/auth.proto',
              },
            ];
          }
          return [];
        },
      ],
      [
        'platform/orders',
        async (_cypher, params) => {
          // No symbol with the exact method name — resolve returns null and
          // the consumer contract gets an empty symbolUid, falling back to
          // name-based hint at cross-impact time.
          if (params?.methodName === 'Login') return [];
          return [];
        },
      ],
    ]);

    const result = await extractor.extractFromManifest(links, dbExecutors);

    const provider = result.contracts.find((c) => c.role === 'provider');
    const consumer = result.contracts.find((c) => c.role === 'consumer');

    // Provider resolved to the concrete proto symbol.
    expect(provider?.symbolUid).toBe('uid-auth-login');
    expect(provider?.symbolRef.filePath).toBe('src/auth.proto');

    // Consumer falls back to a deterministic synthetic uid + name-based ref.
    // The synthetic uid lets the bridge cross-impact query anchor on it
    // even when the indexer doesn't expose a matching symbol.
    expect(consumer?.symbolUid).toBe('manifest::platform/orders::grpc::auth.AuthService/Login');
    expect(consumer?.symbolRef.name).toBe('auth.AuthService/Login');

    expect(result.crossLinks[0].to.symbolRef.filePath).toBe('src/auth.proto');
    expect(result.crossLinks[0].from.symbolUid).toBe(
      'manifest::platform/orders::grpc::auth.AuthService/Login',
    );
  });

  it('does NOT resolve grpc manifest to an arbitrary .proto file', async () => {
    // Regression test for a previous bug: the extractor had an unconditional
    // `OR n.filePath ENDS WITH '.proto'` fallback that returned the first
    // proto symbol in the repo, regardless of whether it matched the contract.
    const links: GroupManifestLink[] = [
      {
        from: 'platform/orders',
        to: 'platform/auth',
        type: 'grpc',
        contract: 'auth.AuthService/Login',
        role: 'consumer',
      },
    ];

    const dbExecutors = new Map<
      string,
      (cypher: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>
    >([
      [
        'platform/auth',
        // Executor returns matches for ANY query (simulates the old buggy
        // fallback that returned a random .proto file). The new code must
        // only accept a hit when the method/service name matches exactly.
        async (_cypher, params) => {
          if (params?.methodName === 'Login' || params?.serviceName === 'auth.AuthService') {
            return [
              {
                uid: 'uid-correct-login',
                name: 'Login',
                filePath: 'src/auth.proto',
              },
            ];
          }
          return [];
        },
      ],
      ['platform/orders', async () => []],
    ]);

    const result = await extractor.extractFromManifest(links, dbExecutors);
    const provider = result.contracts.find((c) => c.role === 'provider');
    // Must resolve to the correct symbol (not a random proto one).
    expect(provider?.symbolUid).toBe('uid-correct-login');
  });

  it('resolves lib manifest links by exact name only', async () => {
    const links: GroupManifestLink[] = [
      {
        from: 'platform/web',
        to: 'platform/shared-lib',
        type: 'lib',
        contract: '@platform/contracts',
        role: 'consumer',
      },
    ];

    const dbExecutors = new Map<
      string,
      (cypher: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>
    >([
      [
        'platform/shared-lib',
        async (_cypher, params) => {
          if (params?.contract !== '@platform/contracts') return [];
          return [
            {
              uid: 'uid-lib',
              name: '@platform/contracts',
              filePath: 'src/index.ts',
            },
          ];
        },
      ],
      [
        'platform/web',
        async (_cypher, params) => {
          if (params?.contract !== '@platform/contracts') return [];
          return [];
        },
      ],
    ]);

    const result = await extractor.extractFromManifest(links, dbExecutors);

    const provider = result.contracts.find((c) => c.role === 'provider');
    const consumer = result.contracts.find((c) => c.role === 'consumer');

    expect(provider?.symbolUid).toBe('uid-lib');
    // Consumer doesn't have a symbol named exactly '@platform/contracts' —
    // exact matching returns null, falling back to the synthetic manifest uid.
    expect(consumer?.symbolUid).toBe('manifest::platform/web::lib::@platform/contracts');
  });

  it('does NOT resolve lib manifest via CONTAINS on name', async () => {
    // Regression test: previous CONTAINS fallback would match "react" to
    // "react-native" or "@types/react". Exact matching must reject both.
    const links: GroupManifestLink[] = [
      {
        from: 'web',
        to: 'packages/ui',
        type: 'lib',
        contract: 'react',
        role: 'consumer',
      },
    ];

    const dbExecutors = new Map<
      string,
      (cypher: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>
    >([
      [
        'packages/ui',
        async (_cypher, params) => {
          // Executor is called with contract='react'. Only exact matches
          // should come back; return only wrong candidates to verify the
          // Cypher uses `=` not `CONTAINS`.
          if (params?.contract === 'react') {
            // Simulated DB returns nothing because it has only "react-native"
            // and "@types/react" — neither is an exact match for "react".
            return [];
          }
          return [];
        },
      ],
      ['web', async () => []],
    ]);

    const result = await extractor.extractFromManifest(links, dbExecutors);
    const provider = result.contracts.find((c) => c.role === 'provider');
    // No exact match → synthetic manifest uid, not a wrong real one.
    expect(provider?.symbolUid).toBe('manifest::packages/ui::lib::react');
  });

  it('normalizes http contract path for exact Route.name match', async () => {
    // Manifest may be written as "/api/orders/" or "api/orders"; both should
    // match the canonical "/api/orders" stored in the graph.
    const variants = ['/api/orders', '/api/orders/', 'api/orders', '//api//orders'];
    for (const raw of variants) {
      const links: GroupManifestLink[] = [
        {
          from: 'gateway',
          to: 'orders-svc',
          type: 'http',
          contract: raw,
          role: 'consumer',
        },
      ];

      let seenParam: string | undefined;
      const dbExecutors = new Map<
        string,
        (cypher: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>
      >([
        [
          'orders-svc',
          async (_cypher, params) => {
            seenParam = params?.normalized as string;
            return [
              {
                uid: 'uid-orders-list',
                name: 'listOrders',
                filePath: 'src/orders.ts',
              },
            ];
          },
        ],
        ['gateway', async () => []],
      ]);

      const result = await extractor.extractFromManifest(links, dbExecutors);
      expect(seenParam).toBe('/api/orders');
      const provider = result.contracts.find((c) => c.role === 'provider');
      expect(provider?.symbolUid).toBe('uid-orders-list');
    }
  });

  it('resolves http contract with explicit METHOD prefix (GET::/api/orders)', async () => {
    // Regression test for Codex finding F1: resolveSymbol was passing the
    // raw `link.contract` through normalizeRoutePath, which turned
    // "GET::/api/orders" into "/GET::/api/orders" and never matched
    // Route.name = "/api/orders". The extractor must strip the METHOD::
    // prefix and pass only the path portion to the Cypher executor.
    const links: GroupManifestLink[] = [
      {
        from: 'gateway',
        to: 'orders-svc',
        type: 'http',
        contract: 'GET::/api/orders',
        role: 'consumer',
      },
    ];

    let seenParam: string | undefined;
    const dbExecutors = new Map<
      string,
      (cypher: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>
    >([
      [
        'orders-svc',
        async (_cypher, params) => {
          seenParam = params?.normalized as string;
          if (seenParam === '/api/orders') {
            return [
              {
                uid: 'uid-orders-list',
                name: 'listOrders',
                filePath: 'src/orders.ts',
              },
            ];
          }
          return [];
        },
      ],
      ['gateway', async () => []],
    ]);

    const result = await extractor.extractFromManifest(links, dbExecutors);

    // The key assertion: $normalized must be the path only, NOT "/GET::/api/orders".
    expect(seenParam).toBe('/api/orders');

    const provider = result.contracts.find((c) => c.role === 'provider');
    expect(provider?.symbolUid).toBe('uid-orders-list');
    expect(provider?.symbolRef.filePath).toBe('src/orders.ts');
  });

  it('resolves http contract with parameterised path (POST::/users/:id)', async () => {
    const links: GroupManifestLink[] = [
      {
        from: 'gateway',
        to: 'users-svc',
        type: 'http',
        contract: 'POST::/users/:id',
        role: 'consumer',
      },
    ];

    let seenParam: string | undefined;
    const dbExecutors = new Map<
      string,
      (cypher: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>
    >([
      [
        'users-svc',
        async (_cypher, params) => {
          seenParam = params?.normalized as string;
          if (seenParam === '/users/:id') {
            return [
              {
                uid: 'uid-update-user',
                name: 'updateUser',
                filePath: 'src/users.ts',
              },
            ];
          }
          return [];
        },
      ],
      ['gateway', async () => []],
    ]);

    const result = await extractor.extractFromManifest(links, dbExecutors);
    expect(seenParam).toBe('/users/:id');
    const provider = result.contracts.find((c) => c.role === 'provider');
    expect(provider?.symbolUid).toBe('uid-update-user');
  });

  it('handles http contract with empty path after METHOD:: (GET::)', async () => {
    // Edge case: "GET::" (empty path after prefix). Normalizer produces "/"
    // — either resolves to a root route or returns null cleanly.
    const links: GroupManifestLink[] = [
      {
        from: 'gateway',
        to: 'orders-svc',
        type: 'http',
        contract: 'GET::',
        role: 'consumer',
      },
    ];

    let seenParam: string | undefined;
    const dbExecutors = new Map<
      string,
      (cypher: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>
    >([
      [
        'orders-svc',
        async (_cypher, params) => {
          seenParam = params?.normalized as string;
          return [];
        },
      ],
      ['gateway', async () => []],
    ]);

    const result = await extractor.extractFromManifest(links, dbExecutors);
    expect(seenParam).toBe('/');
    // No match → synthetic uid, no crash.
    const provider = result.contracts.find((c) => c.role === 'provider');
    // buildContractId canonicalizes the empty path to `/` so contract ids
    // match regardless of trailing-slash variants in the manifest input.
    expect(provider?.symbolUid).toBe('manifest::orders-svc::http::GET::/');
  });

  it('treats empty method portion (::/api/orders) as a bare path', async () => {
    const links: GroupManifestLink[] = [
      {
        from: 'gateway',
        to: 'orders-svc',
        type: 'http',
        contract: '::/api/orders',
        role: 'consumer',
      },
    ];

    let seenParam: string | undefined;
    const dbExecutors = new Map<
      string,
      (cypher: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>
    >([
      [
        'orders-svc',
        async (_cypher, params) => {
          seenParam = params?.normalized as string;
          return [];
        },
      ],
      ['gateway', async () => []],
    ]);

    await extractor.extractFromManifest(links, dbExecutors);
    // "::/api/orders" has no method prefix per buildContractId's regex
    // (`[A-Za-z]+::`), so the whole string is treated as a bare path.
    // Normalizer collapses leading slashes, so "::/api/orders" stays
    // essentially as-is (no alpha prefix match).
    expect(seenParam).toBe('/::/api/orders');
  });

  it('resolves http contract with lowercase verb (get::/api/orders)', async () => {
    const links: GroupManifestLink[] = [
      {
        from: 'gateway',
        to: 'orders-svc',
        type: 'http',
        contract: 'get::/api/orders',
        role: 'consumer',
      },
    ];

    let seenParam: string | undefined;
    const dbExecutors = new Map<
      string,
      (cypher: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>
    >([
      [
        'orders-svc',
        async (_cypher, params) => {
          seenParam = params?.normalized as string;
          if (seenParam === '/api/orders') {
            return [
              {
                uid: 'uid-orders-list',
                name: 'listOrders',
                filePath: 'src/orders.ts',
              },
            ];
          }
          return [];
        },
      ],
      ['gateway', async () => []],
    ]);

    const result = await extractor.extractFromManifest(links, dbExecutors);
    expect(seenParam).toBe('/api/orders');
    const provider = result.contracts.find((c) => c.role === 'provider');
    expect(provider?.symbolUid).toBe('uid-orders-list');
  });

  it('returns null cleanly when no Route matches explicit-method http contract', async () => {
    const links: GroupManifestLink[] = [
      {
        from: 'gateway',
        to: 'orders-svc',
        type: 'http',
        contract: 'GET::/api/orders',
        role: 'consumer',
      },
    ];

    const dbExecutors = new Map<
      string,
      (cypher: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>
    >([
      ['orders-svc', async () => []],
      ['gateway', async () => []],
    ]);

    const result = await extractor.extractFromManifest(links, dbExecutors);
    const provider = result.contracts.find((c) => c.role === 'provider');
    // No match → synthetic uid, caller falls back as today.
    expect(provider?.symbolUid).toBe('manifest::orders-svc::http::GET::/api/orders');
  });

  it('buildContractId round-trip regression for GET::/api/orders', async () => {
    // Verifies buildContractId still produces http::GET::/api/orders for
    // explicit-method form — i.e. the fix to resolveSymbol did not touch
    // buildContractId.
    const links: GroupManifestLink[] = [
      {
        from: 'gateway',
        to: 'orders-svc',
        type: 'http',
        contract: 'GET::/api/orders',
        role: 'consumer',
      },
    ];

    const result = await extractor.extractFromManifest(links);
    const provider = result.contracts.find((c) => c.role === 'provider');
    expect(provider?.contractId).toBe('http::GET::/api/orders');
  });

  it('canonicalizes method casing so get::/api/orders and GET::/api/orders share a contractId', async () => {
    // Regression for Copilot's review on PR #817: without canonicalization,
    // `buildContractId` passed raw casing through (`http::get::/api/orders`)
    // while `parseHttpContract` upper-cased during lookup, fragmenting
    // cross-impact joins between providers and consumers that happened to
    // use different casing conventions in their group.yaml.
    const lower = await extractor.extractFromManifest([
      {
        from: 'gateway',
        to: 'orders-svc',
        type: 'http',
        contract: 'get::/api/orders',
        role: 'consumer',
      },
    ]);
    const upper = await extractor.extractFromManifest([
      {
        from: 'gateway',
        to: 'orders-svc',
        type: 'http',
        contract: 'GET::/api/orders',
        role: 'consumer',
      },
    ]);
    const lowerContractId = lower.contracts.find((c) => c.role === 'provider')?.contractId;
    const upperContractId = upper.contracts.find((c) => c.role === 'provider')?.contractId;
    expect(lowerContractId).toBe('http::GET::/api/orders');
    expect(upperContractId).toBe('http::GET::/api/orders');
    expect(lowerContractId).toBe(upperContractId);
  });

  it('returns empty for no links', async () => {
    const result = await extractor.extractFromManifest([]);
    expect(result.contracts).toHaveLength(0);
    expect(result.crossLinks).toHaveLength(0);
  });

  it('memoizes repeated (repo, type, contract) resolutions so each tuple hits the DB once', async () => {
    const calls: Array<{ repo: string; cypher: string }> = [];
    const execFor = (repo: string) => async (cypher: string) => {
      calls.push({ repo, cypher });
      return [{ uid: `uid::${repo}`, name: 'handler', filePath: 'src/h.ts' }];
    };

    const dbExecutors = new Map<string, (c: string) => Promise<Record<string, unknown>[]>>([
      ['svc/a', execFor('svc/a')],
      ['svc/b', execFor('svc/b')],
    ]);

    // Two links declare the same (repo, type, contract) triple on each side,
    // so naive sequential resolution would run 4 queries; memoization collapses
    // to 2 (one per distinct repo tuple).
    const link: GroupManifestLink = {
      from: 'svc/b',
      to: 'svc/a',
      type: 'http',
      contract: 'GET::/api/orders',
      role: 'consumer',
    };

    await extractor.extractFromManifest([link, { ...link }], dbExecutors);

    // One resolution per distinct (repo, type, contract) — not per (link × side).
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.repo))).toEqual(new Set(['svc/a', 'svc/b']));
  });
});
