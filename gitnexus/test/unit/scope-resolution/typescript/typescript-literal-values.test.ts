import { describe, expect, it } from 'vitest';
import { enumConstants } from '../../../../src/core/ingestion/languages/typescript/enum-arguments.js';
import { numericLiteralValue } from '../../../../src/core/ingestion/languages/typescript/identifiers.js';
import { getTsParser } from '../../../../src/core/ingestion/languages/typescript/query.js';

describe('TypeScript literal evidence', () => {
  it('requires numeric separators to separate digits from the same part of the literal', () => {
    for (const spelling of [
      '1__2',
      '1_',
      '0_1',
      '0x_FF',
      '0b1_2',
      '1_.0',
      '1._0',
      '1e_3',
      '1e+_3',
      '1_n',
      '01n',
    ]) {
      expect(numericLiteralValue(spelling), spelling).toBeUndefined();
    }
    expect(numericLiteralValue('-0xF_F')).toBe(-255);
    expect(numericLiteralValue('0o7_0')).toBe(56);
    expect(numericLiteralValue('0b1_0n')).toBe(2n);
    expect(numericLiteralValue('+1_2.5_0e-1_0')).toBe(12.5e-10);
  });

  it('increments folded enum constants and declines to guess after a runtime expression', () => {
    const source = `enum Flags {
      A = 1 << 2, B, C = (Flags.B | A) * 2, D,
      E = ~(-D) & 0xff, Label = 'he' + 'llo',
      Unknown = getValue(), AfterUnknown, Reset = 12, Last,
      Alias = Flags['Last'], Dynamic = Flags[getValue()],
    }`;
    const declaration = getTsParser().parse(source).rootNode.namedChild(0)!;
    expect(enumConstants(declaration)).toEqual([
      ['A', 4],
      ['B', 5],
      ['C', 10],
      ['D', 11],
      ['E', 10],
      ['Label', 'hello'],
      ['Reset', 12],
      ['Last', 13],
      ['Alias', 13],
    ]);
  });

  it('bounds repeated concatenation of earlier string constants', () => {
    const members = ["K0 = 'xxxx'"];
    for (let i = 1; i <= 17; i++) members.push(`K${i} = K${i - 1} + K${i - 1}`);
    const declaration = getTsParser()
      .parse(`enum E { ${members.join(',')} }`)
      .rootNode.namedChild(0)!;
    const values = new Map(enumConstants(declaration));
    expect(values.get('K2')).toBe('x'.repeat(16));
    expect(values.has('K17')).toBe(false);
  });
});
