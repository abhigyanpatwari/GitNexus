import { describe, expect, it } from 'vitest';
import { embeddingStatusForStartFailure } from '../../src/hooks/useAppState';
import { BackendError } from '../../src/services/backend-client';

describe('embeddingStatusForStartFailure', () => {
  it('maps the shared analyze/embed lock 409 to error, not embedding', () => {
    const error = new BackendError(
      'Another job is already active for this repository',
      409,
      'client',
    );
    expect(embeddingStatusForStartFailure(error)).toBe('error');
    expect(embeddingStatusForStartFailure(error)).not.toBe('embedding');
  });

  it('maps other start failures to error', () => {
    expect(embeddingStatusForStartFailure(new Error('boom'))).toBe('error');
  });
});
