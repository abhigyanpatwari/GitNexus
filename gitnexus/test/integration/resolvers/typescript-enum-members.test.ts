/**
 * TypeScript enum members (#4216).
 *
 * An enum member is a property of the enum OBJECT. `FilterOp.eq` names it, but
 * `op` in `op: FilterOp` is a string or number, so `op.startsWith()` is
 * `String.prototype.startsWith` and `op.eq` is no member at all. The field
 * extractor marks enum members static, and instance dispatch keeps reads,
 * writes and calls off static members, as TypeScript does (TS2576).
 *
 * Vue runs the unique-name property fallback. Its enum members are skipped
 * there: an untyped `x.Off` is no evidence of `Mode.Off`, and the member must
 * not make a same-named object key in another file ambiguous.
 */
import { describe, it, expect } from 'vitest';
import { getRelationships, useFixture } from './helpers.js';

type Edge = ReturnType<typeof getRelationships>[number];
const edge = (e: Edge) => `${e.source} → ${e.targetFilePath}:${e.target}`;

describe('TypeScript enum members (#4216)', () => {
  const result = useFixture('typescript-enum-members', {
    'color.ts': "export enum Color { Red = 'red', Green = 'green' }\n",
    'filter.ts': "export enum FilterOp { startsWith = 'startsWith', eq = 'eq' }\n",
    'cfg.ts':
      'export class Cfg {\n' +
      '  static count = 0;\n' +
      '  inst = 1;\n' +
      '  static load() { return 1; }\n' +
      '}\n',
    'use.ts':
      "import { Color } from './color';\n" +
      "import { FilterOp } from './filter';\n" +
      "import { Cfg } from './cfg';\n" +
      'export function isRed(c: Color) { return c === Color.Red; }\n' +
      "export function isNeg(op: FilterOp) { return op.startsWith('not'); }\n" +
      'export function readOnValue(op: FilterOp) { return op.eq; }\n' +
      'export function readOnEnum() { return FilterOp.eq; }\n' +
      'export function staticReadOnInstance(c: Cfg) { return c.count; }\n' +
      'export function staticWriteOnInstance(c: Cfg) { c.count = 2; }\n' +
      'export function staticCallOnInstance(c: Cfg) { return c.load(); }\n' +
      'export function staticReadOnClass() { return Cfg.count; }\n' +
      'export function staticWriteOnClass() { Cfg.count = 3; }\n' +
      'export function instanceRead(c: Cfg) { return c.inst; }\n',
  });

  const accesses = () => getRelationships(result(), 'ACCESSES').map(edge);
  const calls = () => getRelationships(result(), 'CALLS').map(edge);

  it('keeps the enum symbols and the read through the enum', () => {
    expect(getRelationships(result(), 'HAS_PROPERTY').map(edge)).toEqual(
      expect.arrayContaining(['Color → color.ts:Red', 'Color → color.ts:Green']),
    );
    expect(accesses()).toEqual(
      expect.arrayContaining(['isRed → color.ts:Red', 'readOnEnum → filter.ts:eq']),
    );
    expect(getRelationships(result(), 'USES').map(edge)).toContain('isRed → color.ts:Color');
  });

  it('marks enum members static and readonly', () => {
    const member = [...result().graph.iterNodes()].find(
      (n) =>
        n.label === 'Property' &&
        n.properties.filePath === 'filter.ts' &&
        n.properties.name === 'eq',
    );
    expect(member?.properties).toMatchObject({ isStatic: true, isReadonly: true });
  });

  it('does not link a call on an enum-typed value to an enum member', () => {
    expect(calls().filter((e) => e.startsWith('isNeg →'))).toEqual([]);
  });

  it('does not link a read on an enum-typed value to an enum member', () => {
    expect(accesses().filter((e) => e.startsWith('readOnValue →'))).toEqual([]);
  });

  it('keeps instance reads, writes and calls off static class members', () => {
    for (const fn of ['staticReadOnInstance', 'staticWriteOnInstance']) {
      expect(accesses().filter((e) => e.startsWith(`${fn} →`))).toEqual([]);
    }
    expect(calls().filter((e) => e.startsWith('staticCallOnInstance →'))).toEqual([]);
  });

  it('still links static members through the class and instance fields through a value', () => {
    expect(accesses()).toEqual(
      expect.arrayContaining([
        'staticReadOnClass → cfg.ts:count',
        'staticWriteOnClass → cfg.ts:count',
        'instanceRead → cfg.ts:inst',
      ]),
    );
  });
});

describe('Vue enum members and the unique-name property fallback (#4216)', () => {
  const script = (body: string) => `<script lang="ts">\n${body}export default {};\n</script>\n`;
  const result = useFixture('vue-enum-members', {
    'src/Mode.vue': script("export enum Mode { Off = 'off', Lvl = 'lvl' }\n"),
    'src/Cfg.vue': script('export const cfg = { Lvl: 2 };\n'),
    'src/Use.vue': script(
      'export function readOff(x) { return x.Off; }\n' +
        'export function readLvl(w) { return w.Lvl; }\n',
    ),
  });

  const accesses = () => getRelationships(result(), 'ACCESSES').map(edge);

  it('does not link an untyped read to an enum member by name', () => {
    expect(accesses().filter((e) => e.startsWith('readOff →'))).toEqual([]);
  });

  it('keeps the fallback to an object key that an enum member shares a name with', () => {
    expect(accesses()).toContain('readLvl → src/Cfg.vue:Lvl');
  });
});
