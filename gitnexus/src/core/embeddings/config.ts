import {
  loadCLIConfig,
  loadCLIConfigSync,
  type CLIConfig,
  type CLIEmbeddingConfig,
  type CLIEmbeddingProvider,
} from '../../storage/repo-manager.js';
import { DEFAULT_EMBEDDING_CONFIG } from './types.js';

export type EmbeddingConfigSource = 'overrides' | 'config' | 'env' | 'default';
export type ResolvedEmbeddingMode = 'local' | 'http';

export interface EmbeddingConfigOverrides extends Partial<CLIEmbeddingConfig> {}

export interface ResolvedEmbeddingConfig {
  mode: ResolvedEmbeddingMode;
  provider: CLIEmbeddingProvider;
  model: string;
  dimensions: number;
  baseUrl?: string;
  apiKey: string;
  explicitDimensionsSource?: Exclude<EmbeddingConfigSource, 'default'>;
}

interface ResolvedValue<T> {
  value: T;
  source: EmbeddingConfigSource;
}

const trimToUndefined = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const resolveValue = <T>(
  overridesValue: T | undefined,
  configValue: T | undefined,
  envValue: T | undefined,
  defaultValue: T,
): ResolvedValue<T> => {
  if (overridesValue !== undefined) return { value: overridesValue, source: 'overrides' };
  if (configValue !== undefined) return { value: configValue, source: 'config' };
  if (envValue !== undefined) return { value: envValue, source: 'env' };
  return { value: defaultValue, source: 'default' };
};

const parsePositiveInteger = (
  rawValue: number | string | undefined,
  source: Exclude<EmbeddingConfigSource, 'default'>,
): number | undefined => {
  if (rawValue === undefined) return undefined;

  const parsed =
    typeof rawValue === 'number'
      ? Number.isInteger(rawValue)
        ? rawValue
        : Number.NaN
      : parseInt(rawValue, 10);

  if (Number.isNaN(parsed) || parsed <= 0) {
    const fieldLabel =
      source === 'config'
        ? 'embedding.dimensions'
        : source === 'overrides'
          ? 'embedding dimensions override'
          : 'GITNEXUS_EMBEDDING_DIMS';
    throw new Error(`${fieldLabel} must be a positive integer, got "${rawValue}"`);
  }

  return parsed;
};

const getSavedEmbeddingConfig = (savedConfig: CLIConfig): CLIEmbeddingConfig =>
  savedConfig.embedding ?? {};

const resolveEmbeddingConfigFromSaved = (
  savedConfig: CLIConfig,
  overrides: EmbeddingConfigOverrides = {},
): ResolvedEmbeddingConfig => {
  const savedEmbeddingConfig = getSavedEmbeddingConfig(savedConfig);

  const provider = resolveValue<CLIEmbeddingProvider | undefined>(
    overrides.provider,
    savedEmbeddingConfig.provider,
    undefined,
    undefined,
  );
  const baseUrl = resolveValue<string | undefined>(
    trimToUndefined(overrides.baseUrl),
    trimToUndefined(savedEmbeddingConfig.baseUrl),
    trimToUndefined(process.env.GITNEXUS_EMBEDDING_URL),
    undefined,
  );
  const httpModel = resolveValue<string | undefined>(
    trimToUndefined(overrides.model),
    trimToUndefined(savedEmbeddingConfig.model),
    trimToUndefined(process.env.GITNEXUS_EMBEDDING_MODEL),
    undefined,
  );

  const dimensions = resolveValue<number>(
    parsePositiveInteger(overrides.dimensions, 'overrides'),
    parsePositiveInteger(savedEmbeddingConfig.dimensions, 'config'),
    parsePositiveInteger(process.env.GITNEXUS_EMBEDDING_DIMS, 'env'),
    DEFAULT_EMBEDDING_CONFIG.dimensions,
  );

  const forceLocal = provider.value === 'local';
  const mode: ResolvedEmbeddingMode =
    !forceLocal && baseUrl.value && httpModel.value ? 'http' : 'local';

  const apiKey = resolveValue<string | undefined>(
    trimToUndefined(overrides.apiKey),
    trimToUndefined(savedEmbeddingConfig.apiKey),
    trimToUndefined(process.env.GITNEXUS_EMBEDDING_API_KEY),
    undefined,
  );

  return {
    mode,
    provider: mode === 'http' ? (provider.value ?? 'custom') : 'local',
    model: mode === 'http' ? httpModel.value! : DEFAULT_EMBEDDING_CONFIG.modelId,
    dimensions: mode === 'http' ? dimensions.value : DEFAULT_EMBEDDING_CONFIG.dimensions,
    baseUrl: mode === 'http' ? baseUrl.value!.replace(/\/+$/, '') : undefined,
    apiKey: mode === 'http' ? (apiKey.value ?? 'unused') : '',
    explicitDimensionsSource:
      mode === 'http' && dimensions.source !== 'default' ? dimensions.source : undefined,
  };
};

export const resolveEmbeddingConfigSync = (
  overrides: EmbeddingConfigOverrides = {},
): ResolvedEmbeddingConfig => {
  return resolveEmbeddingConfigFromSaved(loadCLIConfigSync(), overrides);
};

export const resolveEmbeddingConfig = async (
  overrides: EmbeddingConfigOverrides = {},
): Promise<ResolvedEmbeddingConfig> => {
  return resolveEmbeddingConfigFromSaved(await loadCLIConfig(), overrides);
};
