/**
 * The R rename provider refuses a new name that already exists. R keeps one global per name, so
 * a top-level variable of the new name, or a function of that name in another file, is replaced
 * by the renamed function or replaces it, depending on which assignment runs last.
 */
import { describe, expect, it } from 'vitest';
import { rIssue, rVerdict } from '../helpers/r-rename-verdict.js';

const HELPER = 'helper <- function(v) v + 1\n';
const verdict = (source: string, newName = 'assist'): string =>
  rVerdict({ files: { 'a.R': HELPER + source }, newName });

describe('R rename: a new name that already exists', () => {
  it('refuses a top-level variable of the new name, before or after the function', () => {
    for (const source of [
      'assist <- 3\n',
      'assist <- function(v) v * 2\n',
      'assist = 3\n',
      '3 -> assist\n',
      'assist <<- 3\n',
      '3 ->> assist\n',
      'for (assist in 1:3) print(assist)\n',
      '`assist` <- 3\n',
      'if (TRUE) assist <- 3\n',
    ]) {
      expect(rIssue({ files: { 'a.R': HELPER + source }, newName: 'assist' })?.code, source).toBe(
        'name_collision',
      );
      expect(
        rIssue({ files: { 'a.R': source + HELPER }, targetFile: 'a.R', newName: 'assist' })?.code,
        source,
      ).toBe('name_collision');
    }
  });

  it('refuses a variable of the new name in another file', () => {
    expect(
      rIssue({ files: { 'a.R': HELPER, 'b.R': 'assist <- 3\n' }, newName: 'assist' })?.code,
    ).toBe('name_collision');
  });

  it('refuses a function of the new name in another file', () => {
    expect(
      rIssue({
        files: { 'a.R': HELPER, 'b.R': 'assist <- function(v) v * 2\nx <- assist(1)\n' },
        newName: 'assist',
      })?.code,
    ).toBe('name_collision');
  });

  it('refuses a <<- to the new name from inside a function', () => {
    expect(verdict('install <- function() { assist <<- 3 }\n')).toBe('name_collision');
    expect(verdict('install <- function() { 3 ->> assist }\n')).toBe('name_collision');
  });

  it('allows a local assignment, a parameter or a member of the new name', () => {
    for (const source of [
      'f <- function() { assist <- 3 }\n',
      'f <- function(assist) 1\n',
      'f <- function(x) { x$assist <- 1; x }\n',
      'f <- function() list(assist = 1)\n',
      'other <- function(v) v\n',
    ]) {
      expect(verdict(source), source).toBe('ok');
    }
  });
});

describe('R rename: a new name that the sources already read', () => {
  it('refuses a value, a function argument or a callee of the new name', () => {
    for (const source of [
      'r <- sapply(1:3, assist)\n',
      'r <- Reduce(assist, 1:3)\n',
      'x <- assist\n',
      'x <- assist[1]\n',
      'x <- assist$a\n',
      'f <- function(f = assist) f(1)\n',
      'r <- assist(1)\n',
      'r <- 1 |> assist()\n',
      'r <- c(1, 2) |> sapply(assist)\n',
      'r <- y ~ assist\n',
      'print(`assist`)\n',
      'g <- function() { assist <- 3; assist }\n',
    ]) {
      expect(verdict(source), source).toBe('name_collision');
    }
  });

  it('allows a name that is not a read: argument name, member, qualified name, parameter', () => {
    for (const source of [
      'r <- f(assist = 1)\n',
      'r <- x$assist\n',
      'r <- x@assist\n',
      'r <- pkg::assist\n',
      'r <- assist::f(1)\n',
      'r <- pkg:::assist(1)\n',
      'f <- function(assist) assist * 2\n',
      'f <- function(assist, n = assist) n\n',
      'f <- function(assist) { g <- function() assist; g() }\n',
      'f <- function(assist) assist(1)\n',
      '# assist\n',
    ]) {
      expect(verdict(source), source).toBe('ok');
    }
  });

  it('still refuses a call of a parameter that may not hold a function', () => {
    for (const source of [
      'f <- function(assist = 2) assist(1)\n',
      'f <- function(assist = g()) assist(1)\n',
      'f <- function(assist) { assist <- 3; assist(1) }\n',
    ]) {
      expect(verdict(source), source).toBe('name_collision');
    }
  });

  it('reads the new name through backticks and across files', () => {
    expect(
      rVerdict({
        files: { 'a.R': HELPER, 'b.R': 'x <- sapply(1:3, `assist`)\n' },
        newName: 'assist',
      }),
    ).toBe('name_collision');
  });
});
