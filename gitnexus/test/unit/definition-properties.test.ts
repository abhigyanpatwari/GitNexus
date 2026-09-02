import { describe, expect, it, vi } from 'vitest';
import {
  mergeCanonicalDefinitionProperties,
  runDefinitionPropertiesExtractor,
  type DefinitionPropertiesContext,
} from '../../src/core/ingestion/language-provider.js';

const context = {
  nodeLabel: 'Const',
  nodeName: 'endpoint',
  filePath: 'src/endpoints.ts',
  definitionNode: {},
  parsedImports: [],
  isExported: true,
} as unknown as DefinitionPropertiesContext;

describe('definition property provider guardrails', () => {
  it('isolates a throwing extractor and permits the next definition to continue', () => {
    const failure = new Error('provider failed');
    const onError = vi.fn();

    expect(
      runDefinitionPropertiesExtractor(
        () => {
          throw failure;
        },
        context,
        onError,
      ),
    ).toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);

    expect(
      runDefinitionPropertiesExtractor(
        () => ({ convexEndpointFactory: 'query' }),
        context,
        onError,
      ),
    ).toEqual({ convexEndpointFactory: 'query' });
    expect(onError).toHaveBeenCalledOnce();
  });

  it('keeps canonical identity and location fields authoritative', () => {
    const properties = mergeCanonicalDefinitionProperties(
      {
        name: 'spoofed',
        filePath: 'wrong.ts',
        startLine: 999,
        isExported: false,
        convexEndpointFactory: 'query',
      },
      {
        name: 'endpoint',
        filePath: 'src/endpoints.ts',
        startLine: 7,
        isExported: true,
      },
    );

    expect(properties).toEqual({
      name: 'endpoint',
      filePath: 'src/endpoints.ts',
      startLine: 7,
      isExported: true,
      convexEndpointFactory: 'query',
    });
  });
});
