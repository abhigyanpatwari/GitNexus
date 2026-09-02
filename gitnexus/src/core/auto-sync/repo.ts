import { extractRepoName } from '../../server/git-clone.js';
import { validateAutoSyncRemoteUrl } from './config.js';

export function extractRepoNameFromRemoteUrl(remoteUrl: string): string {
  validateAutoSyncRemoteUrl(remoteUrl);
  return extractRepoName(remoteUrl);
}
