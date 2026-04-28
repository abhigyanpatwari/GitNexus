import { describe, expect, it } from 'vitest';
import {
  isLegacyResolverParityExpectedFailure,
  isLegacyResolverParityRun,
  resolverParityFlagName,
} from '../../integration/resolvers/helpers.js';

const csharpNamespaceRootImportTest =
  'emits the using-import edge App/Program.cs -> Models/User.cs through the scope-resolution path';

describe('resolver parity expected legacy failures', () => {
  it('uses the same env var convention as the parity workflow', () => {
    expect(resolverParityFlagName('csharp')).toBe('REGISTRY_PRIMARY_CSHARP');
    expect(resolverParityFlagName('c-plus-plus')).toBe('REGISTRY_PRIMARY_C_PLUS_PLUS');
  });

  it('recognizes only legacy parity runs', () => {
    expect(isLegacyResolverParityRun('csharp', { REGISTRY_PRIMARY_CSHARP: '0' })).toBe(true);
    expect(isLegacyResolverParityRun('csharp', { REGISTRY_PRIMARY_CSHARP: 'false' })).toBe(true);
    expect(isLegacyResolverParityRun('csharp', { REGISTRY_PRIMARY_CSHARP: '1' })).toBe(false);
    expect(isLegacyResolverParityRun('csharp', {})).toBe(false);
  });

  it('matches configured expected failures only during the legacy run', () => {
    expect(
      isLegacyResolverParityExpectedFailure('csharp', csharpNamespaceRootImportTest, {
        REGISTRY_PRIMARY_CSHARP: '0',
      }),
    ).toBe(true);

    expect(
      isLegacyResolverParityExpectedFailure('csharp', csharpNamespaceRootImportTest, {
        REGISTRY_PRIMARY_CSHARP: '1',
      }),
    ).toBe(false);

    expect(
      isLegacyResolverParityExpectedFailure(
        'csharp',
        'detects exactly 3 classes and 2 interfaces',
        {
          REGISTRY_PRIMARY_CSHARP: '0',
        },
      ),
    ).toBe(false);
  });
});
