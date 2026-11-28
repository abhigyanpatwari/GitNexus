import { describe, expect, it } from 'vitest';
import { renderCsharpHeritageType } from '../../../src/core/ingestion/languages/csharp/heritage-type-shape.js';
import { csharpTupleOverride } from '../../../src/core/ingestion/languages/csharp/tuple-overrides.js';
import { compareCodeUnits } from '../../../src/lib/utils.js';
import { useFixture } from './helpers.js';

describe('C# named tuple override signatures', () => {
  const result = useFixture(
    'csharp-named-tuple-overrides',
    {
      'Base.cs': `#nullable enable
using Selected = N;
namespace N { public class Box<X> {} public class Item {} }
namespace Other { public class Item {} }
public class Direct<T> {
  public virtual void Named(global::N.Box<(T key, string value)?> x) {}
  public virtual void Plain(global::N.Box<(T, string)?> x) {}
  public virtual void Label(global::N.Box<(T T, global::N.Item @class)?> x) {}
  public virtual void Deep(global::N.Box<(T[,]? ranks, (T count, global::N.Item obj)? nested)[]?> x) {}
}
public class Base<A> { public virtual void Accept(A x) {} }
public class NamedHop<T> : Base<global::N.Box<(T key, global::N.Item item)?>> {}
public class PlainHop<T> : Base<global::N.Box<(T, global::N.Item)?>> {}
public class Member<T> {
  public virtual (T result, string error) Pick((T key, T value) one, (T id, T size) two) => default;
  public virtual (T result, string error) Status() => default;
  public virtual void Touch(ref global::N.Box<(T key, string value)?> arg) {}
}
public class Ancestor { public virtual void Run((int key, int value) pair) {} }
public class Middle : Ancestor { public override void Run((int, int) pair) {} }
public class AliasHop<T> : Base<global::N.Box<(Selected.Item item, T key)?>> {}
public class Bare { public virtual (int result, string error) Save((int key, string value) p) => default; }`,
      'Use.cs': String.raw`#nullable enable
using Selected = Other;
public class Same : Direct<int> { public override void Named(global::N.Box<(int key, string value)?> x) {} }
public class Rename : Direct<int> { public override void Named(global::N.Box<(int number, string value)?> x) {} }
public class Drop : Direct<int> { public override void Named(global::N.Box<(int, string)?> x) {} }
public class Partial : Direct<int> { public override void Named(global::N.Box<(int key, string)?> x) {} }
public class Add : Direct<int> { public override void Plain(global::N.Box<(int key, string value)?> x) {} }
public class NoLabels : Direct<int> { public override void Plain(global::N.Box<(int, string)?> x) {} }
public class Collision : Direct<int> { public override void Label(global::N.Box<(int T, global::N.Item @class)?> x) {} }
public class NestedArray : Direct<int> { public override void Deep(global::N.Box<(int[,] ranks, (int count, global::N.Item obj)? nested)[]> x) {} }
public class WrongArray : Direct<int> { public void Deep(global::N.Box<(int[] ranks, (int count, global::N.Item obj)? nested)[]> x) {} }
public class WrongLeaf : Direct<int> { public void Label(global::N.Box<(int T, global::Other.Item @class)?> x) {} }
public class Hidden : Direct<int> { public new void Named(global::N.Box<(int changed, string value)?> x) {} }
public class InheritedSame : NamedHop<int> { public override void Accept(global::N.Box<(int key, global::N.Item item)?> x) {} }
public class InheritedRename : NamedHop<int> { public override void Accept(global::N.Box<(int changed, global::N.Item item)?> x) {} }
public class InheritedDrop : NamedHop<int> { public override void Accept(global::N.Box<(int, global::N.Item)?> x) {} }
public class InheritedAdd : PlainHop<int> { public override void Accept(global::N.Box<(int key, global::N.Item item)?> x) {} }
public class InheritedPlain : PlainHop<int> { public override void Accept(global::N.Box<(int, global::N.Item)?> x) {} }
public class WrongRoot : NamedHop<int> { public void Accept(global::N.Box<(int key, global::Other.Item item)?> x) {} }
public class SignatureExact : Member<int> { public override (int result, string error) Pick((int key, int value) one, (int id, int size) two) => default; }
public class SignatureOmitted : Member<int> { public override (int, string) Pick((int, int) one, (int, int) two) => default; }
public class OmitSecond : Member<int> { public override (int result, string error) Pick((int key, int value) one, (int, int) two) => default; }
public class OmitReturn : Member<int> { public override (int, string) Pick((int key, int value) one, (int id, int size) two) => default; }
public class OnlyReturn : Member<int> { public override (int result, string error) Pick((int, int) one, (int, int) two) => default; }
public class ReturnNamed : Member<int> { public override (int result, string error) Status() => default; }
public class ReturnOmitted : Member<int> { public override (int, string) Status() => default; }
public class ReturnRenamed : Member<int> { public override (int x, string error) Status() => default; }
public class Restores : Middle { public override void Run((int key, int value) pair) {} }
public class Nearest : Middle { public override void Run((int, int) pair) {} }
public class Escaped : Direct<int> { public override void Named(global::N.Box<(int @key, string val\u0075e)?> arg) {} }
public class RefTuple : Member<int> { public override void Touch(ref global::N.Box<(int key, string value)?> arg) {} }
public class WrongMode : Member<int> { public void Touch(global::N.Box<(int key, string value)?> arg) {} }
public class HideExact : Direct<int> { public new void Named(global::N.Box<(int key, string value)?> arg) {} }
public class AliasSame : AliasHop<int> { public override void Accept(global::N.Box<(global::N.Item item, int key)?> x) {} }
public class AliasWrong : AliasHop<int> { public void Accept(global::N.Box<(Selected.Item item, int key)?> x) {} }
public class BareSame : Bare { public override (int result, string error) Save((int key, string value) p) => default; }
public class BareOmitted : Bare { public override (int, string) Save((int, string) p) => default; }`,
    },
    { workerPoolSize: 1 },
  );
  it('retains the exact or fully omitted signature and rejects hidden or incompatible slots', () => {
    const actual = [...result().graph.iterRelationshipsByType('METHOD_OVERRIDES')]
      .map((edge) => [edge.sourceId, edge.targetId])
      .sort(([a], [b]) => compareCodeUnits(a, b));
    // Roslyn CS8139 rejects partial, changed or restored labels. The nearest
    // slot controls even if a deeper ancestor has the requested labels.
    expect(actual).toEqual([
      ['Class:Base.cs:Middle', 'Method:Base.cs:Ancestor.Run#1'],
      ['Class:Use.cs:AliasSame', 'Method:Base.cs:Base.Accept#1'],
      ['Class:Use.cs:BareOmitted', 'Method:Base.cs:Bare.Save#1'],
      ['Class:Use.cs:BareSame', 'Method:Base.cs:Bare.Save#1'],
      ['Class:Use.cs:Collision', 'Method:Base.cs:Direct.Label#1'],
      ['Class:Use.cs:Drop', 'Method:Base.cs:Direct.Named#1'],
      ['Class:Use.cs:Escaped', 'Method:Base.cs:Direct.Named#1'],
      ['Class:Use.cs:InheritedDrop', 'Method:Base.cs:Base.Accept#1'],
      ['Class:Use.cs:InheritedPlain', 'Method:Base.cs:Base.Accept#1'],
      ['Class:Use.cs:InheritedSame', 'Method:Base.cs:Base.Accept#1'],
      ['Class:Use.cs:Nearest', 'Method:Base.cs:Middle.Run#1'],
      ['Class:Use.cs:NestedArray', 'Method:Base.cs:Direct.Deep#1'],
      ['Class:Use.cs:NoLabels', 'Method:Base.cs:Direct.Plain#1'],
      ['Class:Use.cs:RefTuple', 'Method:Base.cs:Member.Touch#1'],
      ['Class:Use.cs:ReturnNamed', 'Method:Base.cs:Member.Status#0'],
      ['Class:Use.cs:ReturnOmitted', 'Method:Base.cs:Member.Status#0'],
      ['Class:Use.cs:Same', 'Method:Base.cs:Direct.Named#1'],
      ['Class:Use.cs:SignatureExact', 'Method:Base.cs:Member.Pick#2'],
      ['Class:Use.cs:SignatureOmitted', 'Method:Base.cs:Member.Pick#2'],
    ]);
  });
});

describe('C# tuple names bound in the declaring scope', () => {
  const result = useFixture(
    'csharp-local-named-tuples',
    {
      'Local.cs': `#nullable enable
public class LocalItem {}
public class Parent { public virtual void Pick((LocalItem value, int count) p){} }
public class Child : Parent { public override void Pick((LocalItem value, int count) p){} }
public class ChildDrop : Parent { public override void Pick((LocalItem, int) p){} }
namespace A { public class Item {} } namespace B { public class Item {} }`,
      'Left.cs': `using Chosen = A;
public class Aliased { public virtual void Pick((Chosen.Item value, int count) p) {} }`,
      'Right.cs': `using Chosen = B;
public class Wrong : Aliased { public void Pick((Chosen.Item value, int count) p) {} }
public class Right : Aliased { public override void Pick((global::A.Item value, int count) p) {} }`,
    },
    { workerPoolSize: 1 },
  );
  it('preserves the same-file nominal override and rejects a rebound namespace alias', () => {
    const edges = [...result().graph.iterRelationshipsByType('METHOD_OVERRIDES')]
      .map((edge) => [edge.sourceId, edge.targetId])
      .sort(([a], [b]) => compareCodeUnits(a, b));
    expect(edges).toEqual([
      ['Class:Local.cs:Child', 'Method:Local.cs:Parent.Pick#1'],
      ['Class:Local.cs:ChildDrop', 'Method:Local.cs:Parent.Pick#1'],
      ['Class:Right.cs:Right', 'Method:Left.cs:Aliased.Pick#1'],
    ]);
  });
});

describe('C# named tuple class slots', () => {
  const result = useFixture(
    'csharp-named-tuple-slots',
    {
      'Slots.cs': `public class Root { public virtual void Slot((int key, int value) p) {} }
public class Hiding : Root { public new void Slot((int key, int value) p) {} }
public class HiddenLeaf : Hiding { public override void Slot((int, int) p) {} }
public class Sealing : Root { public sealed override void Slot((int key, int value) p) {} }
public class SealedLeaf : Sealing { public override void Slot((int, int) p) {} }
public abstract class Abstract { public abstract void Slot((int key, int value) p); }
public class Open : Abstract { public override void Slot((int key, int value) p) {} }
public class OpenLeaf : Open { public override void Slot((int, int) p) {} }
public class Private : Root { private new void Slot((int key, int value) p) {} }
public class PrivateLeaf : Private { public override void Slot((int,int) p) {} }
public class Different : Root { public void Slot((long key,int value) p) {} }
public class DifferentLeaf : Different { public override void Slot((int,int) p) {} }
public class NewVirtual : Root { public new virtual void Slot((int key,int value) p) {} }
public class NewVirtualLeaf : NewVirtual { public override void Slot((int,int) p) {} }`,
    },
    { workerPoolSize: 1 },
  );
  it('follows virtual, abstract and open overrides and stops at an accessible closed slot', () => {
    const edges = [...result().graph.iterRelationshipsByType('METHOD_OVERRIDES')]
      .map((edge) => [edge.sourceId, edge.targetId])
      .sort(([a], [b]) => compareCodeUnits(a, b));
    expect(edges).toEqual([
      ['Class:Slots.cs:DifferentLeaf', 'Method:Slots.cs:Root.Slot#1'],
      ['Class:Slots.cs:NewVirtualLeaf', 'Method:Slots.cs:NewVirtual.Slot#1'],
      ['Class:Slots.cs:Open', 'Method:Slots.cs:Abstract.Slot#1'],
      ['Class:Slots.cs:OpenLeaf', 'Method:Slots.cs:Open.Slot#1'],
      ['Class:Slots.cs:PrivateLeaf', 'Method:Slots.cs:Root.Slot#1'],
      ['Class:Slots.cs:Sealing', 'Method:Slots.cs:Root.Slot#1'],
    ]);
  });
});

describe('C# named tuple override eligibility', () => {
  const result = useFixture(
    'csharp-named-tuple-eligibility',
    {
      'Arity.cs': `class Root {
  public virtual void Slot<T>((int key, int value) p) {}
  public virtual void Reverse((int key, int value) p) {}
  public virtual void Decl<T>((int key, int value) p) {}
  public virtual void Order<T,U>((T key, U value) p) {}
}
class Lost : Root { public override void Slot((int, int) p) {} }
class Added : Root { public override void Reverse<U>((int, int) p) {} }
class Same : Root { public override void Decl<U>((int, int) p) {} }
class Renamed : Root { public override void Order<U,V>((U, V) p) {} }
class Swapped : Root { public void Order<U,V>((V, U) p) {} }
class Middle : Root { public new virtual void Slot((int key, int value) p) {} }
class Leaf : Middle { public override void Slot<U>((int, int) p) {} }`,
      'Access.cs': `class Parent {
  public virtual void Pub((int key, int value) p) {}
  protected virtual void Prot((int key, int value) p) {}
  internal virtual void Intr((int key, int value) p) {}
  protected internal virtual void Pi((int key, int value) p) {}
  private protected virtual void Pp((int key, int value) p) {}
}
class Good : Parent {
  public override void Pub((int, int) p) {}
  protected override void Prot((int, int) p) {}
  internal override void Intr((int, int) p) {}
  protected internal override void Pi((int, int) p) {}
  private protected override void Pp((int, int) p) {}
}
class Bad : Parent {
  protected override void Pub((int, int) p) {}
  public override void Prot((int, int) p) {}
  public override void Intr((int, int) p) {}
  protected override void Pi((int, int) p) {}
  protected override void Pp((int, int) p) {}
}`,
      'Returns.cs': `namespace R { public class Box<T> {} }
class ReturnBase<T> {
  public virtual object Reference(global::R.Box<(T left, int right)> p) => default;
  public virtual int Value(global::R.Box<(T left, int right)> p) => 0;
  public virtual (int ok, int reason) Tuple(global::R.Box<(T left, int right)> p) => default;
}
class Valid : ReturnBase<int> {
  public override string Reference(global::R.Box<(int left, int right)> p) => default;
  public override int Value(global::R.Box<(int left, int right)> p) => 1;
  public override (int ok, int reason) Tuple(global::R.Box<(int left, int right)> p) => default;
}
class Invalid : ReturnBase<int> {
  public override int Reference(global::R.Box<(int left, int right)> p) => 1;
  public override long Value(global::R.Box<(int left, int right)> p) => 1;
  public override string Tuple(global::R.Box<(int left, int right)> p) => default;
}`,
    },
    { workerPoolSize: 1 },
  );
  it('matches method type parameters by arity and position before choosing the nearest slot', () => {
    const edges = [...result().graph.iterRelationshipsByType('METHOD_OVERRIDES')]
      .filter((edge) => edge.sourceId.startsWith('Class:Arity.cs:'))
      .map((edge) => [edge.sourceId, edge.targetId])
      .sort(([a], [b]) => compareCodeUnits(a, b));
    expect(edges).toEqual([
      ['Class:Arity.cs:Leaf', 'Method:Arity.cs:Root.Slot#1'],
      ['Class:Arity.cs:Renamed', 'Method:Arity.cs:Root.Order#1'],
      ['Class:Arity.cs:Same', 'Method:Arity.cs:Root.Decl#1'],
    ]);
  });
  it('requires the access modifiers of a same-file override to agree', () => {
    const edges = [...result().graph.iterRelationshipsByType('METHOD_OVERRIDES')]
      .filter((edge) => edge.sourceId.startsWith('Class:Access.cs:'))
      .map((edge) => [edge.sourceId, edge.targetId])
      .sort(([, a], [, b]) => compareCodeUnits(a, b));
    expect(edges).toEqual([
      ['Class:Access.cs:Good', 'Method:Access.cs:Parent.Intr#1'],
      ['Class:Access.cs:Good', 'Method:Access.cs:Parent.Pi#1'],
      ['Class:Access.cs:Good', 'Method:Access.cs:Parent.Pp#1'],
      ['Class:Access.cs:Good', 'Method:Access.cs:Parent.Prot#1'],
      ['Class:Access.cs:Good', 'Method:Access.cs:Parent.Pub#1'],
    ]);
  });
  it('retains reference covariance and rejects boxing and incompatible value returns', () => {
    const edges = [...result().graph.iterRelationshipsByType('METHOD_OVERRIDES')]
      .filter((edge) => edge.sourceId.startsWith('Class:Returns.cs:'))
      .map((edge) => [edge.sourceId, edge.targetId])
      .sort(([, a], [, b]) => compareCodeUnits(a, b));
    expect(edges).toEqual([
      ['Class:Returns.cs:Valid', 'Method:Returns.cs:ReturnBase.Reference#1'],
      ['Class:Returns.cs:Valid', 'Method:Returns.cs:ReturnBase.Tuple#1'],
      ['Class:Returns.cs:Valid', 'Method:Returns.cs:ReturnBase.Value#1'],
    ]);
  });
});

it('recognizes tuple labels only at C# token boundaries', () => {
  const identifier = 'A'.repeat(4096);
  expect(renderCsharpHeritageType('(' + identifier + '[],int)')).toBe('(' + identifier + '[],int)');
  expect(renderCsharpHeritageType('(N.@class,int)')).toBe('(N.@class,int)');
  expect(
    renderCsharpHeritageType('(int@name,int[]items,N.G<int>group,(int,int)pair,int?maybe)'),
  ).toBe('(int @name,int[] items,N.G<int> group,(int,int) pair,int? maybe)');
  const labels: (string | undefined)[] = [];
  expect(
    renderCsharpHeritageType(String.raw`(int @é,string na\u006De)`, undefined, false, {
      omitLabels: true,
      visit(label) {
        labels.push(label);
      },
    }),
  ).toBe('(int,string)');
  expect(labels).toEqual(['é', 'name']);
  expect(renderCsharpHeritageType('(int value,)')).toBeUndefined();
});

it('defers protected internal access across files when the assembly boundary is unknown', () => {
  const ownMethod = { name: 'M', filePath: 'Child.cs', visibility: 'protected', isOverride: true };
  const baseMethod = {
    name: 'M',
    filePath: 'Parent.cs',
    visibility: 'protected internal',
    isVirtual: true,
  };
  expect(
    csharpTupleOverride.compare({
      overriding: ['(int, int)'],
      inherited: ['(int key, int value)'],
      ownMethod,
      baseMethod,
      specializeReturns: () => ['void', 'void'],
    }),
  ).toBeUndefined();
});
