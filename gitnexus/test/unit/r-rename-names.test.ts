/**
 * The R rename provider's name checks say what is wrong with a name. `...` and `..1` are reserved
 * in R, so they are not "a collision"; a new name with a non-ASCII character is refused because
 * the provider reads ASCII identifiers only (conservative by design); an old name made only of
 * non-ASCII characters (`λ`) is an identifier the provider does not support, not an operator.
 */
import { describe, expect, it } from 'vitest';
import { rRenameProvider } from '../../src/core/ingestion/languages/r/rename.js';
import { rIssue } from '../helpers/r-rename-verdict.js';

const check = (name: string): { code: string; message: string } | undefined => {
  const issue = rRenameProvider.validateName?.(name);
  return issue ? { code: issue.code, message: issue.message } : undefined;
};

describe('R rename: validateName', () => {
  it.each(['...', '..1', '..2', '..10', '..0'])('rejects the reserved name %s', (name) => {
    const issue = check(name);
    expect(issue?.code).toBe('invalid_name');
    expect(issue?.message).toMatch(/reserved/);
  });

  it.each(['..', '.x', '..x', 'x..1', '.a1', 'helper'])('still accepts %s', (name) => {
    expect(check(name)).toBeUndefined();
  });

  it.each(['λ', 'café', 'aé', 'x_δ'])('rejects the non-ASCII name %s and says why', (name) => {
    const issue = check(name);
    expect(issue?.code).toBe('invalid_name');
    expect(issue?.message).toMatch(/ASCII/);
    expect(issue?.message).toMatch(/conservative/);
  });

  it.each(['1x', '_x', 'a b', 'if', 'NULL', '.1', ''])(
    'keeps the general message for %s',
    (name) => {
      const issue = check(name);
      expect(issue?.code).toBe('invalid_name');
      expect(issue?.message).toBe('Choose a valid nonreserved R identifier.');
    },
  );
});

describe('R rename: an old name of non-ASCII characters only', () => {
  it('is reported as an unsupported identifier, not as an operator', () => {
    const issue = rIssue({ files: { 'a.R': 'λ <- function(v) v\n' }, target: 'λ', newName: 'lam' });
    expect(issue?.code).toBe('unsupported_occurrence');
    expect(issue?.message).toMatch(/not a supported identifier/);
    expect(issue?.message).not.toMatch(/operator/);
  });

  it('still reports an operator as an operator', () => {
    const issue = rIssue({
      files: { 'a.R': '`+` <- function(a, b) a\n' },
      target: '`+`',
      newName: 'f',
    });
    expect(issue?.message).toMatch(/operator/);
  });
});
