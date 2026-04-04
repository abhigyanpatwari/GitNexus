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

  it('returns empty for no links', async () => {
    const result = await extractor.extractFromManifest([]);
    expect(result.contracts).toHaveLength(0);
    expect(result.crossLinks).toHaveLength(0);
  });
});
