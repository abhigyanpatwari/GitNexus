import { createHash } from 'node:crypto';
import type { EmbeddingIdentity } from './embedding-identity.js';
import type { EmbeddingConfig } from './types.js';
import type { ContentRetention } from '../../storage/repo-meta.js';

export interface EmbeddingGraphIdentity {
  generation: string;
  coveredContent: string;
  revision: string;
  analyzer: string;
  parser: string;
  schema: string;
  vectorSchema: string;
}

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Explicit fields exclude credentials and scheduling settings from persisted identity. */
export function embeddingJobIdentity(
  graph: EmbeddingGraphIdentity,
  vector: EmbeddingIdentity,
  textVersion: string,
  config: Pick<
    EmbeddingConfig,
    'chunkSize' | 'overlap' | 'maxSnippetLength' | 'maxDescriptionLength' | 'maxInputChars'
  > &
    Partial<Pick<EmbeddingConfig, 'chunkStrategy'>>,
  contentRetention: ContentRetention = 'full',
): { identity: string; sourceIdentity: string; vectorIdentity: string; inputIdentity: string } {
  const source = [
    graph.generation,
    graph.coveredContent,
    graph.revision,
    graph.analyzer,
    graph.parser,
    graph.schema,
    graph.vectorSchema,
  ];
  if (
    source.some((value) => typeof value !== 'string' || !value) ||
    !vector.model ||
    !/^(local|http:[a-f0-9]{64})$/.test(vector.provider) ||
    !Number.isSafeInteger(vector.dimensions) ||
    vector.dimensions < 1 ||
    !textVersion ||
    ![
      config.chunkSize,
      config.overlap,
      config.maxSnippetLength,
      config.maxDescriptionLength,
      config.maxInputChars,
    ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    config.chunkSize < 1 ||
    config.overlap >= config.chunkSize ||
    config.maxInputChars < 2 ||
    !['ast', 'fixed'].includes(config.chunkStrategy ?? 'ast') ||
    !['full', 'symbol', 'none'].includes(contentRetention)
  )
    throw new Error('Incomplete embedding job identity');
  const sourceIdentity = digest(source);
  const vectorIdentity = digest([vector.provider, vector.model, vector.dimensions]);
  const inputIdentity = digest([
    'source-aware-ast-inputs:v1',
    textVersion,
    config.chunkStrategy ?? 'ast',
    contentRetention,
    config.chunkSize,
    config.overlap,
    config.maxSnippetLength,
    config.maxDescriptionLength,
    config.maxInputChars,
  ]);
  return {
    sourceIdentity,
    vectorIdentity,
    inputIdentity,
    identity: digest([1, sourceIdentity, vectorIdentity, inputIdentity]),
  };
}
