/**
 * The R rename provider refuses getter/setter pairs. `helper(z) <- v` calls the replacement
 * function `` `helper<-` ``, not `helper`, so renaming the getter would strand the setter, and
 * renaming the setter would leave every `helper(z) <- v` calling a function that no longer
 * exists. Each refusal is paired with a call outside an assignment target.
 */
import { describe, expect, it } from 'vitest';
import { rVerdict } from '../helpers/r-rename-verdict.js';

const GETTER = 'helper <- function(x) x$val\n';
const verdict = (source: string, newName = 'accessor', target = 'helper'): string =>
  rVerdict({ files: { 'a.R': GETTER + source }, target, newName });

describe('R rename: getter and setter pairs', () => {
  it('refuses a call that sits in an assignment target', () => {
    for (const source of [
      'helper(z) <- 5\n',
      'helper(z) = 5\n',
      'helper(z) <<- 5\n',
      '5 -> helper(z)\n',
      '5 ->> helper(z)\n',
      'f <- function() helper(z) <- 5\n',
    ]) {
      expect(verdict(source), source).toBe('unsupported_occurrence');
    }
  });

  it('refuses a call nested in a longer assignment target', () => {
    for (const source of [
      'helper(z)$a <- 1\n',
      'helper(z)[[1]] <- 1\n',
      'names(helper(z)) <- "b"\n',
      'attr(helper(z), "k") <- 1\n',
      'helper(z)@slot <- 1\n',
    ]) {
      expect(verdict(source), source).toBe('unsupported_occurrence');
    }
  });

  it('allows a call that is only read, or assigned from', () => {
    for (const source of [
      'y <- helper(z)\n',
      'y = helper(z)\n',
      'helper(z) -> y\n',
      'print(helper(z))\n',
      'y$a <- helper(z)\n',
      'names(y) <- helper(z)\n',
    ]) {
      expect(verdict(source), source).toBe('ok');
    }
  });

  it('refuses a name or a new name that ends in <-', () => {
    expect(
      rVerdict({
        files: { 'a.R': '`helper<-` <- function(x, value) x\n' },
        target: '`helper<-`',
        newName: 'setter',
      }),
    ).toBe('unsupported_occurrence');
    expect(rVerdict({ files: { 'a.R': GETTER }, newName: 'helper<-' })).toBe(
      'unsupported_occurrence',
    );
  });

  it('refuses a getter whose setter is defined by a string, or a new name that names one', () => {
    expect(verdict('"helper<-" <- function(x, value) x\n')).toBe('unsupported_occurrence');
    expect(verdict("'helper<-' <- function(x, value) x\n")).toBe('unsupported_occurrence');
    expect(verdict('"accessor<-" <- function(x, value) x\n')).toBe('unsupported_occurrence');
    expect(verdict('"other<-" <- function(x, value) x\n')).toBe('ok');
  });
});
