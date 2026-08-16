import { createHash } from 'node:crypto';

const SOURCE_IDENTITY_TAG = /~src:[a-f0-9]{64}$/;

/** Physical graph-id suffix for a provider-supplied exact source-site identity. */
export function sourceIdentityIdTag(sourceIdentity: string | undefined): string {
  if (sourceIdentity === undefined || sourceIdentity.length === 0) return '';
  return `~src:${createHash('sha256').update(sourceIdentity).digest('hex')}`;
}

/** Remove only the terminal source-site tag; logical names remain unchanged. */
export function stripSourceIdentityIdTag(value: string): string {
  return value.replace(SOURCE_IDENTITY_TAG, '');
}
