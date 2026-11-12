/**
 * The R rename provider refuses an infix function or operator as the old or the new name. A use
 * such as `a %+% b` is an operator token, not an identifier, so a rename would edit only the
 * definition and leave every infix use calling a function that no longer exists.
 */
import { describe, expect, it } from 'vitest';
import { rVerdict } from '../helpers/r-rename-verdict.js';

const INFIX = '`%+%` <- function(a, b) paste0(a, b)\nx <- "a" %+% "b"\n';

describe('R rename: infix functions and operators', () => {
  it('refuses to rename an infix function, however it is used', () => {
    expect(rVerdict({ files: { 'a.R': INFIX }, target: '`%+%`', newName: 'plus' })).toBe(
      'unsupported_occurrence',
    );
    for (const name of ['`%||%`', '`%>>%`', '`%in%`', '`%o%`']) {
      expect(
        rVerdict({ files: { 'a.R': `${name} <- function(a, b) a\n` }, target: name, newName: 'f' }),
        name,
      ).toBe('unsupported_occurrence');
    }
  });

  it('refuses a defined operator such as `+` or `[[`', () => {
    for (const name of ['`+`', '`[[`', '`!`', '`==`']) {
      expect(
        rVerdict({ files: { 'a.R': `${name} <- function(a, b) a\n` }, target: name, newName: 'f' }),
        name,
      ).toBe('unsupported_occurrence');
    }
  });

  it('refuses a new name spelled as an infix function or operator', () => {
    for (const newName of ['%+%', '%in%', '+', '[[']) {
      expect(rVerdict({ files: { 'a.R': 'helper <- function(v) v\n' }, newName }), newName).toBe(
        'unsupported_occurrence',
      );
    }
  });

  it('still renames a backticked name that is not an operator', () => {
    expect(
      rVerdict({
        files: { 'a.R': '`my fn` <- function(v) v\nx <- `my fn`(1)\n' },
        target: '`my fn`',
        newName: 'my_fn',
      }),
    ).toBe('ok');
    expect(rVerdict({ files: { 'a.R': 'helper <- function(v) v\n' }, newName: 'assist' })).toBe(
      'ok',
    );
    // Dots and underscores are part of an ordinary name.
    expect(rVerdict({ files: { 'a.R': '. <- function(v) v\n' }, target: '.', newName: 'g' })).toBe(
      'ok',
    );
  });
});
