import { extractRepoName } from '../../server/git-clone.js';
import { validateAutoSyncRemoteUrl } from './config.js';

export function extractRepoNameFromRemoteUrl(
  remoteUrl: string,
  allowedHosts?: readonly string[],
): string {
  validateAutoSyncRemoteUrl(remoteUrl, allowedHosts);
  return extractRepoName(remoteUrl);
}
