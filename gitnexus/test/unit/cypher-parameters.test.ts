import { describe, expect, it } from 'vitest';
import { missingCypherParameters } from '../../src/mcp/local/cypher-parameters.js';

describe('missingCypherParameters', () => {
  it.each([
    ['a misspelled name', 'MATCH (n) WHERE n.name = $nmae RETURN n', { name: 'x' }, ['nmae']],
    ['no params at all', 'MATCH (n) WHERE n.id = $id AND n.k = $k RETURN n', {}, ['id', 'k']],
    ['a name used twice', 'RETURN $a + $a', {}, ['a']],
    ['every name supplied', 'RETURN $a, $b_2', { a: 1, b_2: 2 }, []],
    ['no parameters', 'MATCH (n) RETURN n', {}, []],
  ] as const)('%s', (_label, statement, params, missing) => {
    expect(missingCypherParameters(statement, params)).toEqual(missing);
  });

  it.each([
    ['a single-quoted string', "RETURN '$notaparam' AS s"],
    ['a double-quoted string', 'RETURN "$notaparam" AS s'],
    ['an escaped quote inside a string', "RETURN 'it\\'s $notaparam' AS s"],
    ['a quoted name', 'RETURN 1 AS `$notaparam`'],
    ['a doubled backtick inside a quoted name', 'RETURN 1 AS `a``$notaparam`'],
    ['a line comment', 'RETURN 1 // $notaparam\n'],
    ['a block comment', 'RETURN /* $notaparam */ 1'],
  ])('a $ inside %s is not a reference', (_label, statement) => {
    expect(missingCypherParameters(statement, {})).toEqual([]);
  });

  it('finds a reference after a literal that contains a dollar sign', () => {
    expect(missingCypherParameters("RETURN '$s', $real", {})).toEqual(['real']);
  });

  it.each([
    ['an unterminated string', "RETURN '$a"],
    ['an unterminated block comment', 'RETURN 1 /* $a'],
    ['a positional parameter', 'RETURN $1, $a'],
    ['a lone dollar sign', 'RETURN $ + $a'],
  ])('reports nothing for a statement with %s', (_label, statement) => {
    expect(missingCypherParameters(statement, {})).toEqual([]);
  });

  // The engine keys a quoted parameter by its spelling with the backticks.
  it.each([
    ['no params', 'RETURN $`my param`', {}, ['`my param`']],
    ['the name without its backticks', 'RETURN $`my param`', { 'my param': 1 }, ['`my param`']],
    ['the spelling with its backticks', 'RETURN $`my param`', { '`my param`': 1 }, []],
    ['a doubled backtick in the spelling', 'RETURN $`a``b`', { '`a``b`': 1 }, []],
    ['a plain name after a quoted one', 'RETURN $`a b`, $c', {}, ['`a b`', 'c']],
  ] as const)('a quoted parameter with %s', (_label, statement, params, missing) => {
    expect(missingCypherParameters(statement, params)).toEqual(missing);
  });

  it('reports nothing for an unterminated quoted parameter', () => {
    expect(missingCypherParameters('RETURN $`a, $b', {})).toEqual([]);
  });

  it('does not take inherited properties as supplied parameters', () => {
    expect(missingCypherParameters('RETURN $toString', {})).toEqual(['toString']);
  });
});
