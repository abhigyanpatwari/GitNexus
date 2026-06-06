import fs from 'fs/promises';
import path from 'path';
import type { WikiRunResult } from './generator.js';

export type WikiAutoRefreshStatus = 'skipped' | 'dry-run' | 'ready' | 'complete' | 'failed';

export type WikiAutoRefreshReason =
  | 'graph-not-fresh'
  | 'missing-wiki-meta'
  | 'corrupt-wiki-meta'
  | 'provider-not-ready'
  | 'dry-run'
  | 'ready'
  | 'refreshed'
  | 'refresh-failed';

export interface WikiAutoRefreshGraphFreshness {
  isFresh: boolean;
  indexedCommit?: string;
  currentCommit?: string;
  source?: string;
  reason?: string;
}

export interface WikiAutoRefreshMetaStatus {
  exists: boolean;
  valid?: boolean;
  path?: string;
  fromCommit?: string;
  model?: string;
  lang?: string;
  reason?: string;
}

export interface WikiAutoRefreshProviderStatus {
  ready: boolean;
  provider?: string;
  source?: string;
  reason?: string;
}

export interface WikiAutoRefreshInputs {
  graphFreshness: WikiAutoRefreshGraphFreshness;
  wikiMeta: WikiAutoRefreshMetaStatus;
  provider: WikiAutoRefreshProviderStatus;
  dryRun?: boolean;
  mutateOutput?: boolean;
  createIfMissing?: boolean;
}

export interface WikiAutoRefreshPlan {
  status: WikiAutoRefreshStatus;
  reason: WikiAutoRefreshReason;
  shouldRunGenerator: boolean;
  willMutateOutput: boolean;
  willRunLLM: boolean;
  dryRun: boolean;
  messages: string[];
  graphFreshness: WikiAutoRefreshGraphFreshness;
  wikiMeta: WikiAutoRefreshMetaStatus;
  provider: WikiAutoRefreshProviderStatus;
}

export interface WikiAutoRefreshResult extends WikiAutoRefreshPlan {
  durationMs?: number;
  wikiRun?: WikiRunResult;
  errorMessage?: string;
}

export interface WikiAutoRefreshRunnerOptions extends WikiAutoRefreshInputs {
  runGenerator: () => Promise<WikiRunResult>;
  now?: () => number;
}

const message = (summary: string, detail?: string): string => (detail ? `${summary}: ${detail}` : summary);

export const planWikiAutoRefresh = (inputs: WikiAutoRefreshInputs): WikiAutoRefreshPlan => {
  const dryRun = inputs.dryRun ?? true;
  const base = {
    dryRun,
    graphFreshness: inputs.graphFreshness,
    wikiMeta: inputs.wikiMeta,
    provider: inputs.provider,
  };

  if (!inputs.graphFreshness.isFresh) {
    return {
      ...base,
      status: 'skipped',
      reason: 'graph-not-fresh',
      shouldRunGenerator: false,
      willMutateOutput: false,
      willRunLLM: false,
      messages: [
        message('Wiki auto-refresh skipped because graph freshness is not confirmed', inputs.graphFreshness.reason),
      ],
    };
  }

  if (!inputs.wikiMeta.exists && !inputs.createIfMissing) {
    return {
      ...base,
      status: 'skipped',
      reason: 'missing-wiki-meta',
      shouldRunGenerator: false,
      willMutateOutput: false,
      willRunLLM: false,
      messages: [
        message('Wiki auto-refresh skipped because no existing wiki metadata was found', inputs.wikiMeta.path),
      ],
    };
  }

  if (inputs.wikiMeta.exists && inputs.wikiMeta.valid === false) {
    return {
      ...base,
      status: 'skipped',
      reason: 'corrupt-wiki-meta',
      shouldRunGenerator: false,
      willMutateOutput: false,
      willRunLLM: false,
      messages: [
        message('Wiki auto-refresh skipped because existing wiki metadata is not readable', inputs.wikiMeta.reason),
      ],
    };
  }

  if (!inputs.provider.ready) {
    return {
      ...base,
      status: 'skipped',
      reason: 'provider-not-ready',
      shouldRunGenerator: false,
      willMutateOutput: false,
      willRunLLM: false,
      messages: [
        message('Wiki auto-refresh skipped because no unattended LLM provider is ready', inputs.provider.reason),
      ],
    };
  }

  if (dryRun || !inputs.mutateOutput) {
    return {
      ...base,
      status: 'dry-run',
      reason: 'dry-run',
      shouldRunGenerator: false,
      willMutateOutput: false,
      willRunLLM: false,
      messages: ['Wiki auto-refresh dry-run: prerequisites are ready, but output mutation is disabled'],
    };
  }

  return {
    ...base,
    status: 'ready',
    reason: 'ready',
    shouldRunGenerator: true,
    willMutateOutput: true,
    willRunLLM: true,
    messages: ['Wiki auto-refresh ready: prerequisites are satisfied and output mutation is enabled'],
  };
};

export const runWikiAutoRefresh = async (
  options: WikiAutoRefreshRunnerOptions,
): Promise<WikiAutoRefreshResult> => {
  const plan = planWikiAutoRefresh(options);
  if (!plan.shouldRunGenerator) {
    return { ...plan, durationMs: 0 };
  }

  const now = options.now ?? Date.now;
  const startedAt = now();
  try {
    const wikiRun = await options.runGenerator();
    return {
      ...plan,
      status: 'complete',
      reason: 'refreshed',
      durationMs: now() - startedAt,
      wikiRun,
      messages: [...plan.messages, 'Wiki auto-refresh completed'],
    };
  } catch (err) {
    return {
      ...plan,
      status: 'failed',
      reason: 'refresh-failed',
      durationMs: now() - startedAt,
      errorMessage: err instanceof Error ? err.message : String(err),
      messages: [...plan.messages, 'Wiki auto-refresh failed'],
    };
  }
};

export const readWikiAutoRefreshMeta = async (
  storagePath: string,
): Promise<WikiAutoRefreshMetaStatus> => {
  const metaPath = path.join(storagePath, 'wiki', 'meta.json');
  try {
    const raw = await fs.readFile(metaPath, 'utf-8');
    const meta = JSON.parse(raw) as {
      fromCommit?: string;
      model?: string;
      lang?: string;
    };
    return {
      exists: true,
      valid: true,
      path: metaPath,
      fromCommit: meta.fromCommit,
      model: meta.model,
      lang: meta.lang,
    };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') {
      return { exists: false, valid: false, path: metaPath };
    }
    return {
      exists: true,
      valid: false,
      path: metaPath,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
};
