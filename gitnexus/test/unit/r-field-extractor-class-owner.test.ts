/**
 * The S4 / RefClass field extractor must attach slots to the class the call defines,
 * which is the argument that takes the `Class` formal (by name, else the first
 * unnamed one), not the first string-valued argument. `setClass(contains = "Base",
 * Class = "A", representation = ...)` defines `A`; `Base` is only its parent.
 *
 * Both owner paths are covered: `RFieldExtractor.extract` (the field metadata) and
 * `getRTopLevelPropertyOwnerName` (the `ownerNameHint` that ties each slot Property
 * to its class), since they must agree.
 */
import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import R from '@eagleoutice/tree-sitter-r';
import { SupportedLanguages } from 'gitnexus-shared';
import {
  RFieldExtractor,
  getRTopLevelPropertyOwnerName,
} from '../../src/core/ingestion/field-extractors/r.js';
import type { FieldExtractorContext } from '../../src/core/ingestion/field-types.js';

const parser = new Parser();
parser.setLanguage(R as Parameters<Parser['setLanguage']>[0]);
const extractor = new RFieldExtractor();
const context = {
  filePath: 'classes.R',
  language: SupportedLanguages.R,
} as unknown as FieldExtractorContext;

/** The first `setClass` / `setRefClass` call in `source`. */
function classCall(source: string): Parser.SyntaxNode {
  const tree = parser.parse(source, undefined, { bufferSize: 1 << 24 });
  const calls = tree.rootNode
    .descendantsOfType('call')
    .filter((c) =>
      ['setClass', 'setRefClass'].includes(c.childForFieldName('function')?.text ?? ''),
    );
  expect(calls).toHaveLength(1);
  return calls[0];
}

function extracted(source: string) {
  const result = extractor.extract(classCall(source), context);
  return result === null
    ? null
    : { owner: result.ownerFqn, fields: result.fields.map((f) => f.name) };
}

/** The slot Property's `ownerNameHint` target: the owner name of the first slot entry. */
function propertyOwner(source: string): string | null {
  const call = classCall(source);
  const slot = call
    .descendantsOfType('argument')
    .find((a) => a.childForFieldName('name')?.text === 'x');
  expect(slot).toBeDefined();
  return getRTopLevelPropertyOwnerName(slot as Parser.SyntaxNode);
}

const SLOTS = 'representation = representation(x = "numeric")';

describe('R field extractor: slots attach to the Class argument', () => {
  it('uses the positional first argument (unchanged behaviour)', () => {
    const source = `setClass("A", ${SLOTS})`;
    expect(extracted(source)).toEqual({ owner: 'A', fields: ['x'] });
    expect(propertyOwner(source)).toBe('A');
  });

  it('still reads slots= and setRefClass(fields=) for a positional class', () => {
    expect(extracted('setClass("A", slots = list(x = "numeric"))')).toEqual({
      owner: 'A',
      fields: ['x'],
    });
    expect(extracted('setRefClass("R", fields = list(x = "numeric"))')).toEqual({
      owner: 'R',
      fields: ['x'],
    });
  });

  it('does not attach slots to a contains= string that precedes Class= (the reported defect)', () => {
    const source = `setClass(contains = "Base", Class = "A", ${SLOTS})`;
    expect(extracted(source)).toEqual({ owner: 'A', fields: ['x'] });
    expect(extracted(source)?.owner).not.toBe('Base');
    expect(propertyOwner(source)).toBe('A');
  });

  it('finds Class= when it follows the representation argument', () => {
    const source = `setClass(${SLOTS}, Class = "A")`;
    expect(extracted(source)).toEqual({ owner: 'A', fields: ['x'] });
    expect(propertyOwner(source)).toBe('A');
  });

  it('finds Class= after a contains= string and the representation argument', () => {
    const source = `setClass(contains = "Base", ${SLOTS}, Class = "A")`;
    expect(extracted(source)?.owner).toBe('A');
    expect(propertyOwner(source)).toBe('A');
  });

  it('takes the first unnamed argument when contains= precedes it', () => {
    const source = `setClass(contains = "Base", "A", ${SLOTS})`;
    expect(extracted(source)).toEqual({ owner: 'A', fields: ['x'] });
    expect(propertyOwner(source)).toBe('A');
  });

  it('accepts the Class formal spelled in backticks or quotes', () => {
    for (const formal of ['`Class`', '"Class"']) {
      const source = `setClass(contains = "Base", ${formal} = "A", ${SLOTS})`;
      expect(extracted(source)).toEqual({ owner: 'A', fields: ['x'] });
      expect(propertyOwner(source)).toBe('A');
    }
  });

  it('attaches setRefClass fields to the Class argument as well', () => {
    const source = 'setRefClass(contains = "Base", Class = "R", fields = list(x = "numeric"))';
    expect(extracted(source)).toEqual({ owner: 'R', fields: ['x'] });
    expect(propertyOwner(source)).toBe('R');
  });

  it('names no owner (so no slots) when the Class argument is not a string', () => {
    const source = `setClass(contains = "Base", Class = cls, ${SLOTS})`;
    expect(extracted(source)).toBeNull();
    expect(propertyOwner(source)).toBeNull();
  });
});

describe('RFieldExtractor: slots = c(...) / fields = c(...)', () => {
  const details = (source: string) =>
    extractor
      .extract(classCall(source), context)
      ?.fields.map((f) => [f.name, f.type] as [string, string | null]);

  it('reads the names and types of a named vector', () => {
    expect(details('setClass("A", slots = c(a = "numeric", b = "character"))')).toEqual([
      ['a', 'numeric'],
      ['b', 'character'],
    ]);
    expect(details('setRefClass("R", fields = c(n = "numeric"))')).toEqual([['n', 'numeric']]);
  });

  it('reads the strings of an unnamed vector as untyped names', () => {
    expect(details('setClass("A", slots = c("a", "b"))')).toEqual([
      ['a', null],
      ['b', null],
    ]);
    expect(details('setRefClass("R", fields = c("n"))')).toEqual([['n', null]]);
  });

  it('keeps named and unnamed entries of one vector together', () => {
    expect(details('setClass("A", slots = c("a", b = "numeric"))')).toEqual([
      ['a', null],
      ['b', 'numeric'],
    ]);
  });

  it('does not read an unnamed string of representation() or list()', () => {
    expect(
      details('setClass("A", representation = representation("VIRTUAL", x = "numeric"))'),
    ).toEqual([['x', 'numeric']]);
    expect(details('setClass("A", slots = list("a"))')).toBeUndefined();
  });
});
