/**
 * Unit tests for validateAnalyzeToken — the optional `token` validation on
 * POST /api/analyze. Tested directly (not via a booted server) since the
 * route validation is otherwise only reachable through createServer.
 *
 * Closes the test gap (finding 12) and locks the github.com host-bind
 * (finding 6) and CRLF/charset guards from the PR #2223 tri-review.
 */
import { describe, it, expect } from 'vitest';
import { validateAnalyzeToken } from '../../src/server/api.js';

const GH = 'https://github.com/owner/repo';

describe('validateAnalyzeToken', () => {
  it('returns null when no token is provided', () => {
    expect(validateAnalyzeToken(undefined, GH)).toBeNull();
    expect(validateAnalyzeToken(undefined, undefined)).toBeNull();
  });

  it('accepts a well-formed token for a github.com URL', () => {
    expect(validateAnalyzeToken('ghp_abc123', GH)).toBeNull();
    expect(validateAnalyzeToken('ghp_abc123', 'https://www.github.com/o/r')).toBeNull();
  });

  it('rejects a non-string token', () => {
    expect(validateAnalyzeToken(123 as unknown, GH)).toEqual({
      status: 400,
      error: '"token" must be a string',
    });
  });

  it('rejects an empty or over-long token', () => {
    expect(validateAnalyzeToken('', GH)?.error).toBe('"token" length must be between 1 and 256');
    expect(validateAnalyzeToken('a'.repeat(257), GH)?.error).toBe(
      '"token" length must be between 1 and 256',
    );
  });

  it('rejects a token with characters that could smuggle a header (CRLF/space/colon)', () => {
    for (const bad of ['abc def', 'abc\r\nHost: x', 'x-access-token:abc', 'abc<script>']) {
      expect(validateAnalyzeToken(bad, GH)?.error).toBe('"token" contains invalid characters');
    }
  });

  it('rejects a token without a url', () => {
    expect(validateAnalyzeToken('ghp_abc123', undefined)?.error).toBe('"token" requires "url"');
    expect(validateAnalyzeToken('ghp_abc123', '')?.error).toBe('"token" requires "url"');
  });

  it('rejects a token for a non-github host (host-bind)', () => {
    for (const url of [
      'https://gitlab.com/o/r',
      'https://dev.azure.com/o/p/_git/r',
      'https://github.com.evil.com/o/r',
      'https://api.github.com/o/r',
    ]) {
      expect(validateAnalyzeToken('ghp_abc123', url)?.error).toBe(
        '"token" is only supported for github.com URLs',
      );
    }
  });

  it('treats github.com@evil.com as the evil host (userinfo, not host)', () => {
    // new URL(...).hostname is evil.com here — must be rejected.
    expect(validateAnalyzeToken('ghp_abc123', 'https://github.com@evil.com/o/r')?.error).toBe(
      '"token" is only supported for github.com URLs',
    );
  });

  it('rejects a token when the url is unparseable', () => {
    expect(validateAnalyzeToken('ghp_abc123', 'not-a-url')?.error).toBe(
      '"url" must be a valid URL when "token" is provided',
    );
  });
});
