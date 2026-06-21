import { describe, expect, it } from 'vitest';

import { safeUrl } from '../../src/core/embeddings/http-client.js';

describe('safeUrl', () => {
  it('strips userinfo credentials, keeping host + port + path', () => {
    const masked = safeUrl('http://user:s3cret@host:11434/v1');
    expect(masked).not.toContain('user');
    expect(masked).not.toContain('s3cret');
    expect(masked).toContain('host:11434');
    expect(masked).toContain('/v1');
  });

  it('strips a query string that may carry a token', () => {
    const masked = safeUrl('http://host/v1?api_key=secret123');
    expect(masked).not.toContain('secret123');
    expect(masked).not.toContain('?');
    expect(masked).toContain('host');
    expect(masked).toContain('/v1');
  });

  it('returns a sentinel for an unparseable URL instead of echoing it', () => {
    expect(safeUrl('://nope')).toBe('<invalid-url>');
  });

  it('passes a plain URL through (protocol + host + path)', () => {
    expect(safeUrl('http://10.219.32.29:11434/v1')).toBe('http://10.219.32.29:11434/v1');
  });
});
