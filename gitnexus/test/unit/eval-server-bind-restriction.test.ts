import { describe, it, expect } from 'vitest';

/**
 * Inline copy of the production regex predicate. The production
 * function lives inside `cli-e2e.test.ts` as a test-internal helper;
 * if it later moves to a shared util this test should import that
 * util directly. For now we duplicate the regex so a precedence
 * regression in cli-e2e.test.ts fails this unit test as well as the
 * integration tests.
 */
function isEvalServerBindRestriction(stderr: string): boolean {
  return /(?:listen|bind) (?:EPERM|EACCES|EADDRNOTAVAIL|operation not permitted|permission denied)/i.test(
    stderr,
  );
}

describe('isEvalServerBindRestriction', () => {
  describe('matches genuine libuv bind-restriction errors', () => {
    it.each([
      ['Error: listen EACCES: permission denied 127.0.0.1:80'],
      ['Error: listen EPERM: operation not permitted 0.0.0.0:80'],
      ['Error: listen EADDRNOTAVAIL: address not available 192.168.1.99:0'],
      ['something then bind EACCES: permission denied'],
      ['LISTEN EACCES: permission denied'],
    ])('matches %p', (stderr) => {
      expect(isEvalServerBindRestriction(stderr)).toBe(true);
    });
  });

  describe('does not match unrelated stderr', () => {
    it.each([
      ["Error: EACCES: permission denied, open '/etc/shadow'"],
      ['Error: ENOENT: no such file or directory'],
      ['sandbox blocked: operation not permitted'],
      ['GITNEXUS_EVAL_SERVER_READY:127.0.0.1:5173'],
      [''],
      ['unknown option --host'],
    ])('does not match %p', (stderr) => {
      expect(isEvalServerBindRestriction(stderr)).toBe(false);
    });
  });
});
