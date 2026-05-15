import { describe, expect, it } from 'vitest';
import {
  isLegacyResolverParityExpectedFailure,
  isLegacyResolverParityRun,
  resolverParityFlagName,
} from '../../integration/resolvers/helpers.js';

const csharpNamespaceRootImportTest =
  'emits the using-import edge App/Program.cs -> Models/User.cs through the scope-resolution path';
const cppBaseNamespaceAdlTests = [
  'resolves log(d) to base_lib::log via ADL when Derived inherits from base_lib::Base',
  'resolves trace(m) via full MRO walk when MultiLevel inherits via middle_lib::Mid -> base_lib::Root',
  'diamond inheritance contributes base namespace once (no duplicate/crash)',
] as const;

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

  it('does not mark cpp base-namespace ADL coverage as expected failures in legacy parity', () => {
    for (const testName of cppBaseNamespaceAdlTests) {
      expect(
        isLegacyResolverParityExpectedFailure('cpp', testName, {
          REGISTRY_PRIMARY_CPP: '0',
        }),
      ).toBe(false);
    }
  });
});
