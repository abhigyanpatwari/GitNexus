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

  it('returns empty for no links', async () => {
    const result = await extractor.extractFromManifest([]);
    expect(result.contracts).toHaveLength(0);
    expect(result.crossLinks).toHaveLength(0);
  });
});
