import type { TFunction } from 'i18next';
import { BackendError, fetchActiveAnalyzeJobs } from '../services/backend-client';

export function formatBackendError(error: unknown, t: TFunction): string {
  if (error instanceof BackendError) {
    const seconds = error.retryAfterMs ? Math.ceil(error.retryAfterMs / 1000) : undefined;
    const fallback = error.message || t('errors:unknown');
    switch (error.code) {
      case 'network':
        return t('errors:backend.network', { defaultValue: fallback });
      case 'timeout':
        return t('errors:backend.timeout', { defaultValue: fallback });
      case 'rate_limited':
        return t('errors:backend.rateLimited', { seconds, defaultValue: fallback });
      case 'not_found':
        return t('errors:backend.notFound', { defaultValue: fallback });
      case 'unauthorized':
        return t('errors:backend.unauthorized', { defaultValue: fallback });
      case 'origin_blocked':
        return t('errors:backend.originBlocked', { defaultValue: fallback });
      case 'client':
        return t('errors:backend.client', { message: error.message, defaultValue: fallback });
      case 'server':
        return t('errors:backend.server', { message: error.message, defaultValue: fallback });
      default:
        return fallback;
    }
  }

  return error instanceof Error ? error.message : t('errors:unknown');
}

/**
 * Message for a failed analyze start. A 409 means another job holds the
 * server's single analyze slot, so name that job instead of showing the raw
 * "already in progress (job <id>)" text (#1584).
 */
export async function formatAnalyzeStartError(error: unknown, t: TFunction): Promise<string> {
  if (error instanceof BackendError && error.status === 409) {
    const [job] = await fetchActiveAnalyzeJobs().catch(() => []);
    if (job?.repoName) {
      return t('errors:analyzeBusy', {
        repoName: job.repoName,
        percent: Math.round(job.progress.percent),
      });
    }
  }
  return formatBackendError(error, t);
}
