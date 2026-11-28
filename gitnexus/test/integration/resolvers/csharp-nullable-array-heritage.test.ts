import { compareStringTuples } from '../../../tools/compiler-conformance/compare.mjs';
import { describe, expect, it } from 'vitest';
import { useFixture } from './helpers.js';

describe('C# array and tuple identities in inherited signatures', () => {
  const result = useFixture(
    'csharp-nullable-array-heritage',
    {
      'Container.cs': `#nullable enable
using Item = N.Item;
using Chosen = N;
namespace N {
  public class Box<T> {}
  public struct Packet<T> {}
  public class Item {}
}
namespace Shadow { public class Item {} }
public class Base<A> { public virtual void Accept(A value) {} }
public class ArrayHop<T> : Base<global::N.Box<T[]?>> {}
public class JaggedHop<T> : Base<global::N.Box<T[]?[,]?>> {}
public class TupleHop<T> : Base<global::N.Box<(T, string?)?>> {}
public class ElementHop<T> : Base<global::N.Box<T?[]?>> where T : struct {}
public class DeepHop<T> : Base<global::N.Box<(global::N.Packet<T>?[,]?, T[]?)?[]?>> {}
public class OpenHop<T> : Base<global::N.Box<T?[]?>> {}
public class Roots<T> : Base<global::N.Box<(global::N.Item[], T)?>> {}
public class Via<T> { public virtual void Direct(global::N.Box<T[]?> value) {} }
public class AliasHop<T> : Base<global::N.Box<(Item[], T)?>> {}
public class RefBase<A> { public virtual void Touch(ref A value) {} }
public class RefArray<T> : RefBase<global::N.Box<T[]?>> {}
public class NamespaceHop<T> : Base<global::N.Box<(Chosen.Item[], T)?>> {}`,
      'Use.cs': `#nullable enable
using Item = Shadow.Item;
using Chosen = Shadow;
public class Matched : ArrayHop<int> { public override void Accept(global::N.Box<int[]?> value) {} }
public class Erased : ArrayHop<int> { public override void Accept(global::N.Box<int[]> value) {} }
public class WrongRank : ArrayHop<int> { public void Accept(global::N.Box<int[,]> value) {} }
public class Jagged : JaggedHop<int> { public override void Accept(global::N.Box<int[,][]> value) {} }
public class Reverse : JaggedHop<int> { public void Accept(global::N.Box<int[][,]> value) {} }
public class Tuple : TupleHop<int> { public override void Accept(global::N.Box<(int, string)?> value) {} }
public class NonNullableTuple : TupleHop<int> { public void Accept(global::N.Box<(int, string)> value) {} }
public class Element : ElementHop<int> { public override void Accept(global::N.Box<int?[]> value) {} }
public class WrongElement : ElementHop<int> { public void Accept(global::N.Box<int[]> value) {} }
public class Deep : DeepHop<int> { public override void Accept(global::N.Box<(global::N.Packet<int>?[,], int[])?[]> value) {} }
public class Open : OpenHop<int> { public override void Accept(global::N.Box<int[]> value) {} }
public class WrongOpen : OpenHop<int> { public void Accept(global::N.Box<int?[]> value) {} }
public class SameRoot : Roots<int> { public override void Accept(global::N.Box<(global::N.Item[], int)?> value) {} }
public class DifferentRoot : Roots<int> { public void Accept(global::N.Box<(global::Shadow.Item[], int)?> value) {} }
public class Declared : Via<int> { public override void Direct(global::N.Box<int[]> value) {} }
public class WrongDeclared : Via<int> { public void Direct(global::N.Box<int[,]> value) {} }
public class ActualArray : ArrayHop<int[,]> { public override void Accept(global::N.Box<int[][,]> value) {} }
public class WrongActualArray : ArrayHop<int[,]> { public void Accept(global::N.Box<int[,][]> value) {} }
public class DirectArray : Via<int[,]> { public override void Direct(global::N.Box<int[][,]> value) {} }
public class WrongDirectArray : Via<int[,]> { public void Direct(global::N.Box<int[,][]> value) {} }
public class AliasRebound : AliasHop<int> { public void Accept(global::N.Box<(Item[], int)?> value) {} }
public class RefAccess : RefArray<int> { public override void Touch(ref global::N.Box<int[]> value) {} }
public class ByValue : RefArray<int> { public void Touch(global::N.Box<int[]> value) {} }
public class OpenArray : OpenHop<int[,]> { public override void Accept(global::N.Box<int[][,]> value) {} }
public class WrongOpenArray : OpenHop<int[,]> { public void Accept(global::N.Box<int[,][]> value) {} }
public class ConflictingAlias : Roots<int> { public void Accept(global::N.Box<(Item[], int)?> value) {} }
public class NamespaceAlias : NamespaceHop<int> { public override void Accept(global::N.Box<(global::N.Item[], int)?> value) {} }
public class WrongNamespaceAlias : NamespaceHop<int> { public void Accept(global::N.Box<(Chosen.Item[], int)?> value) {} }`,
    },
    { workerPoolSize: 1 },
  );

  it('keeps the exact CLR slot, passing mode, rank order, value nullability and declaring namespace', () => {
    const overrides = [...result().graph.iterRelationshipsByType('METHOD_OVERRIDES')]
      .map(({ sourceId, targetId }) => [sourceId, targetId])
      .sort(compareStringTuples);
    const target = 'Method:Container.cs:Base.Accept#1';
    expect(overrides).toEqual([
      ['Class:Use.cs:ActualArray', target],
      ['Class:Use.cs:Declared', 'Method:Container.cs:Via.Direct#1'],
      ['Class:Use.cs:Deep', target],
      ['Class:Use.cs:DirectArray', 'Method:Container.cs:Via.Direct#1'],
      ['Class:Use.cs:Element', target],
      ['Class:Use.cs:Erased', target],
      ['Class:Use.cs:Jagged', target],
      ['Class:Use.cs:Matched', target],
      ['Class:Use.cs:NamespaceAlias', target],
      ['Class:Use.cs:Open', target],
      ['Class:Use.cs:OpenArray', target],
      ['Class:Use.cs:RefAccess', 'Method:Container.cs:RefBase.Touch#1'],
      ['Class:Use.cs:SameRoot', target],
      ['Class:Use.cs:Tuple', target],
    ]);
  });
});
