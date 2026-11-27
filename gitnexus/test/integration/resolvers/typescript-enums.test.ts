/**
 * TypeScript enums and their identifier-named members are graph symbols
 * (TYPESCRIPT-03).
 *
 * The scope query already declared both; the parse query minted no node, so
 * `context({name: 'Color'})` answered "Symbol not found" and `Color.Red` had
 * no ACCESSES target. Members are owner-qualified (`Color.Red`), so the rows
 * below pin the exact target against a same-named class field.
 *
 * Only the enum object carries its members. The no-target rows check the two
 * ways a member name could still draw a wrong edge: a value typed as the enum
 * (`op.startsWith()` calls the string method), and Vue's unique-name property
 * fallback (an untyped `x.Off` is no evidence of `Mode.Off`).
 */
import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture } from './helpers.js';

describe('TypeScript enums', () => {
  const result = useFixture('ts-enums', {
    'color.ts': `
export enum Color { Red = 'red', Green = 'green' }
enum Plain { A, B }
export const enum Flag { On = 1, Off = 0 }
declare enum Ambient { X }
export enum Quoted { 'kebab-case' = 1, Dotted = 2 }
export enum Op { startsWith = 'startsWith', equals = 'equals', length = 'length' }
export class Palette { Red = '#f00'; }
export namespace Theme { export enum Shade { Dark, Light } }
export namespace Print { export enum Shade { Matte } }
export function compute() { return 1; }
export enum Size { Big = compute(), Small = 2 }
enum Merged { A }
enum Merged { B = 1 }
export function mergedReads() { return [Merged.A, Merged.B]; }
`,
    'index.ts': `
export * from './color';
export { Color as Hue } from './color';
`,
    'use.ts': `
import { Color, Flag, Op, Palette, Theme } from './color';
import * as C from './color';
import { Color as Barrel, Hue } from './index';

export function isRed(c: Color): boolean {
  return c === Color.Red;
}
export function flagOn() {
  return Flag.On;
}
export function paletteRed(p: Palette) {
  return p.Red;
}
export function viaNamespace() {
  return C.Color.Green;
}
export function viaBarrel() {
  return Barrel.Red;
}
export function viaAlias() {
  return Hue.Green;
}
export function untyped(x) {
  return x.Red;
}
export function anyTyped(x: any) {
  return x.Green;
}
export function typedCall(op: Op) {
  return op.startsWith('not');
}
export function typedRead(op: Op) {
  return op.length;
}
export function dottedCall(op: C.Op) {
  return op.startsWith('x');
}
export class Holder {
  op: Op = Op.equals;
  fieldCall() {
    return this.op.startsWith('x');
  }
  fieldRead() {
    return this.op.length;
  }
}
export function chained(h: Holder) {
  const p = h.op;
  return p.length;
}
export function nestedShade() {
  return Theme.Shade.Dark;
}
export function viaObjectAlias() {
  const E = Op;
  return E.equals;
}
`,
    'Toggle.vue': `
<script setup lang="ts">
enum Mode { On, Off, Busy }
enum Tone { trim = 'trim' }
const mode = Mode.On;
function tidy(t: Tone) { return t.trim(); }
</script>
<template><div>{{ mode }}</div></template>
`,
    'Panel.vue': `
<script setup lang="ts">
function pick(x) { return x.Off; }
function readBusy(o) { return o.Busy; }
</script>
<template><div /></template>
`,
    'State.vue': `
<script setup lang="ts">
const state = { Busy: true };
</script>
<template><div>{{ state }}</div></template>
`,
  });

  const nodeIds = (label: string): string[] => {
    const ids: string[] = [];
    result().graph.forEachNode((n) => {
      if (n.label === label) ids.push(n.id);
    });
    return ids.sort();
  };

  const edges = (type: string): string[] =>
    getRelationships(result(), type)
      .map((e) => `${e.rel.sourceId} -> ${e.rel.targetId}`)
      .sort();

  const from = (type: string, source: string): string[] =>
    edges(type).filter((e) => e.startsWith(`${source} -> `));

  const readsFrom = (fn: string): string[] => from('ACCESSES', `Function:use.ts:${fn}`);

  // The no-target rows below would pass vacuously if an id-scheme change
  // renamed their callers, so every caller must exist first.
  it('has a live node for every caller the rows read from', () => {
    const ids = [...nodeIds('Function'), ...nodeIds('Method')];
    const callers = [
      ...[
        'isRed',
        'flagOn',
        'paletteRed',
        'viaNamespace',
        'viaBarrel',
        'viaAlias',
        'untyped',
        'anyTyped',
        'typedCall',
        'typedRead',
        'dottedCall',
        'chained',
        'nestedShade',
        'viaObjectAlias',
      ].map((fn) => `Function:use.ts:${fn}`),
      'Method:use.ts:Holder.fieldCall#0',
      'Method:use.ts:Holder.fieldRead#0',
      'Function:Toggle.vue:tidy',
      'Function:color.ts:mergedReads',
      'Function:Panel.vue:pick',
      'Function:Panel.vue:readBusy',
    ];
    expect(callers.filter((id) => !ids.includes(id))).toEqual([]);
  });

  it('indexes plain, exported, const, declare, namespaced and Vue enums as Enum nodes', () => {
    expect(nodeIds('Enum')).toEqual([
      'Enum:Toggle.vue:Mode',
      'Enum:Toggle.vue:Tone',
      'Enum:color.ts:Ambient',
      'Enum:color.ts:Color',
      'Enum:color.ts:Flag',
      'Enum:color.ts:Merged',
      'Enum:color.ts:Op',
      'Enum:color.ts:Plain',
      'Enum:color.ts:Quoted',
      'Enum:color.ts:Shade',
      'Enum:color.ts:Size',
    ]);
  });

  it('indexes bare and initialized members as Property nodes owned by their enum', () => {
    expect(edges('HAS_PROPERTY').filter((e) => e.startsWith('Enum:'))).toEqual([
      'Enum:Toggle.vue:Mode -> Property:Toggle.vue:Mode.Busy',
      'Enum:Toggle.vue:Mode -> Property:Toggle.vue:Mode.Off',
      'Enum:Toggle.vue:Mode -> Property:Toggle.vue:Mode.On',
      'Enum:Toggle.vue:Tone -> Property:Toggle.vue:Tone.trim',
      'Enum:color.ts:Ambient -> Property:color.ts:Ambient.X',
      'Enum:color.ts:Color -> Property:color.ts:Color.Green',
      'Enum:color.ts:Color -> Property:color.ts:Color.Red',
      'Enum:color.ts:Flag -> Property:color.ts:Flag.Off',
      'Enum:color.ts:Flag -> Property:color.ts:Flag.On',
      'Enum:color.ts:Merged -> Property:color.ts:Merged.A',
      'Enum:color.ts:Merged -> Property:color.ts:Merged.B',
      'Enum:color.ts:Op -> Property:color.ts:Op.equals',
      'Enum:color.ts:Op -> Property:color.ts:Op.length',
      'Enum:color.ts:Op -> Property:color.ts:Op.startsWith',
      'Enum:color.ts:Plain -> Property:color.ts:Plain.A',
      'Enum:color.ts:Plain -> Property:color.ts:Plain.B',
      'Enum:color.ts:Quoted -> Property:color.ts:Quoted.Dotted',
      'Enum:color.ts:Shade -> Property:color.ts:Shade.Dark',
      'Enum:color.ts:Shade -> Property:color.ts:Shade.Light',
      'Enum:color.ts:Shade -> Property:color.ts:Shade.Matte',
      'Enum:color.ts:Size -> Property:color.ts:Size.Big',
      'Enum:color.ts:Size -> Property:color.ts:Size.Small',
    ]);
  });

  // A member named by a string that is not an identifier ('kebab-case') cannot
  // be read with dot access. Identifier-valid quoted names ('Valid' = 1) are
  // skipped too; see TYPESCRIPT-03.
  it('does not mint a node for a string-named member', () => {
    const ids: string[] = [];
    result().graph.forEachNode((n) => {
      if (n.id.includes('kebab')) ids.push(n.id);
    });
    expect(ids).toEqual([]);
  });

  it('links a direct member read to the enum member, not a same-named class field', () => {
    expect(readsFrom('isRed')).toEqual(['Function:use.ts:isRed -> Property:color.ts:Color.Red']);
    expect(readsFrom('flagOn')).toEqual(['Function:use.ts:flagOn -> Property:color.ts:Flag.On']);
    expect(readsFrom('paletteRed')).toEqual([
      'Function:use.ts:paletteRed -> Property:color.ts:Palette.Red',
    ]);
  });

  it('links member reads through a namespace import, a barrel and an aliased re-export', () => {
    // `C.Color` is itself a read of the namespace's export, as `C.Klass` is for a class.
    expect(readsFrom('viaNamespace')).toEqual([
      'Function:use.ts:viaNamespace -> Enum:color.ts:Color',
      'Function:use.ts:viaNamespace -> Property:color.ts:Color.Green',
    ]);
    expect(readsFrom('viaBarrel')).toEqual([
      'Function:use.ts:viaBarrel -> Property:color.ts:Color.Red',
    ]);
    expect(readsFrom('viaAlias')).toEqual([
      'Function:use.ts:viaAlias -> Property:color.ts:Color.Green',
    ]);
  });

  it('leaves member names on untyped and any receivers unlinked', () => {
    expect(readsFrom('untyped')).toEqual([]);
    expect(readsFrom('anyTyped')).toEqual([]);
  });

  // A value typed `Op` is a string, so `op.startsWith()` is
  // `String.prototype.startsWith` and `op.length` is the string's length.
  it('does not link a value typed as the enum to the enum members', () => {
    const intoOp = (e: string) => e.includes('-> Property:color.ts:Op.');
    expect(from('CALLS', 'Function:use.ts:typedCall')).toEqual([]);
    expect(readsFrom('typedRead')).toEqual([]);
    expect(from('CALLS', 'Function:use.ts:dottedCall')).toEqual([]);
    expect(readsFrom('chained').filter(intoOp)).toEqual([]);
    expect(from('CALLS', 'Method:use.ts:Holder.fieldCall#0').filter(intoOp)).toEqual([]);
    expect(from('ACCESSES', 'Method:use.ts:Holder.fieldCall#0').filter(intoOp)).toEqual([]);
    expect(from('ACCESSES', 'Method:use.ts:Holder.fieldRead#0').filter(intoOp)).toEqual([]);
    // Vue script blocks share the rule: `t.trim()` is String.prototype.trim.
    expect(from('CALLS', 'Function:Toggle.vue:tidy')).toEqual([]);
    // The enum object still reaches its member.
    expect(from('ACCESSES', 'Class:use.ts:Holder')).toEqual([
      'Class:use.ts:Holder -> Property:color.ts:Op.equals',
    ]);
  });

  it('links a member read inside a Vue script block', () => {
    expect(from('ACCESSES', 'File:Toggle.vue')).toEqual([
      'File:Toggle.vue -> Property:Toggle.vue:Mode.On',
    ]);
  });

  // Vue keeps the unique-name property fallback. Enum members stay out of it:
  // `x.Off` must not reach `Mode.Off`, and `Mode.Busy` must not make the
  // object key `state.Busy` ambiguous.
  it('keeps Vue enum members out of the unique-name property fallback', () => {
    expect(from('ACCESSES', 'Function:Panel.vue:pick')).toEqual([]);
    expect(from('ACCESSES', 'Function:Panel.vue:readBusy')).toEqual([
      'Function:Panel.vue:readBusy -> Property:State.vue:state.Busy',
    ]);
  });

  it('links a parameter annotation to the enum it names', () => {
    expect(from('USES', 'Function:use.ts:isRed')).toEqual([
      'Function:use.ts:isRed -> Enum:color.ts:Color',
    ]);
  });

  // A call in an initializer belongs to the enum, as a call in a class field
  // initializer belongs to the class. Without an Enum node it came from the file.
  it('attributes a call in a member initializer to the enum', () => {
    expect(from('CALLS', 'Enum:color.ts:Size')).toEqual([
      'Enum:color.ts:Size -> Function:color.ts:compute',
    ]);
  });

  // KNOWN GAP. A member read through a namespace chain resolves to nothing,
  // as a class behind the same chain (`Tools.Helper.run()`) does on main.
  // When namespace-qualified receivers resolve, this row should flip to
  // `Property:color.ts:Shade.Dark`.
  it('KNOWN GAP: leaves a member read through a namespace chain unlinked', () => {
    expect(readsFrom('nestedShade')).toEqual([]);
  });

  // KNOWN GAP. `const E = Op` binds `E` to the type `Op`, so the typed-value
  // guard cannot tell the enum object from a value of the enum type. Main has
  // no edge here either. This should flip to `Property:color.ts:Op.equals`
  // once an alias of the enum object is told apart from a typed value.
  it('KNOWN GAP: leaves a read through a local alias of the enum object unlinked', () => {
    expect(readsFrom('viaObjectAlias').filter((e) => e.includes('Property:color.ts:Op.'))).toEqual(
      [],
    );
  });

  // KNOWN GAP. Same-named enums in sibling namespaces share one node, because
  // TypeScript ids do not include the enclosing namespace. Same-named classes
  // in sibling namespaces share one node on main too. When ids include the
  // namespace, this should become two Enum nodes.
  it('KNOWN GAP: merges same-named enums from sibling namespaces into one node', () => {
    expect(edges('HAS_PROPERTY').filter((e) => e.startsWith('Enum:color.ts:Shade -> '))).toEqual([
      'Enum:color.ts:Shade -> Property:color.ts:Shade.Dark',
      'Enum:color.ts:Shade -> Property:color.ts:Shade.Light',
      'Enum:color.ts:Shade -> Property:color.ts:Shade.Matte',
    ]);
  });

  // KNOWN GAP. Two `enum Merged` blocks share one node, and only the last
  // block's members resolve, as merged interfaces do on main. Both reads
  // should link once merged declarations resolve every block.
  it('KNOWN GAP: resolves only the last block of a merged enum', () => {
    expect(from('ACCESSES', 'Function:color.ts:mergedReads')).toEqual([
      'Function:color.ts:mergedReads -> Property:color.ts:Merged.B',
    ]);
  });
});
