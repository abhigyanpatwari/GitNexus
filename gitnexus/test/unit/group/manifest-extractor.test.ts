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

  it('resolves grpc manifest links to concrete provider and consumer symbols', async () => {
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
          if (params?.contract !== 'auth.AuthService/Login') return [];
          return [
            {
              uid: 'uid-auth-login',
              name: 'Login',
              filePath: 'src/auth.proto',
            },
          ];
        },
      ],
      [
        'platform/orders',
        async (_cypher, params) => {
          if (params?.contract !== 'auth.AuthService/Login') return [];
          return [
            {
              uid: 'uid-orders-client',
              name: 'AuthServiceClient',
              filePath: 'src/client.ts',
            },
          ];
        },
      ],
    ]);

    const result = await extractor.extractFromManifest(links, dbExecutors);

    const provider = result.contracts.find((c) => c.role === 'provider');
    const consumer = result.contracts.find((c) => c.role === 'consumer');

    expect(provider?.symbolUid).toBe('uid-auth-login');
    expect(provider?.symbolRef.filePath).toBe('src/auth.proto');
    expect(consumer?.symbolUid).toBe('uid-orders-client');
    expect(consumer?.symbolRef.filePath).toBe('src/client.ts');
    expect(result.crossLinks[0].to.symbolRef.filePath).toBe('src/auth.proto');
    expect(result.crossLinks[0].from.symbolRef.filePath).toBe('src/client.ts');
  });

  it('resolves lib manifest links to concrete provider and consumer symbols', async () => {
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
          return [
            {
              uid: 'uid-importer',
              name: 'contractsClient',
              filePath: 'src/app.ts',
            },
          ];
        },
      ],
    ]);

    const result = await extractor.extractFromManifest(links, dbExecutors);

    const provider = result.contracts.find((c) => c.role === 'provider');
    const consumer = result.contracts.find((c) => c.role === 'consumer');

    expect(provider?.symbolUid).toBe('uid-lib');
    expect(consumer?.symbolUid).toBe('uid-importer');
    expect(result.crossLinks[0].to.symbolUid).toBe('uid-lib');
    expect(result.crossLinks[0].from.symbolUid).toBe('uid-importer');
  });

  it('returns empty for no links', async () => {
    const result = await extractor.extractFromManifest([]);
    expect(result.contracts).toHaveLength(0);
    expect(result.crossLinks).toHaveLength(0);
  });
});
