import { describe, expect, it } from 'vitest';
import { compareCodeUnits } from '../../../src/lib/utils.js';
import { useFixture } from './helpers.js';

function expectOverrides(
  result: ReturnType<typeof useFixture>,
  file: string,
  owners: Record<string, string[]>,
) {
  const actual = [...result().graph.iterRelationshipsByType('METHOD_OVERRIDES')]
    .map((edge) => edge.sourceId + ' -> ' + edge.targetId)
    .sort(compareCodeUnits);
  const expected = Object.entries(owners)
    .flatMap(([owner, targets]) =>
      targets.map((target) => `Class:${file}:${owner} -> Method:${file}:${target}#1`),
    )
    .sort(compareCodeUnits);
  expect(actual).toEqual(expected);
}

describe('C# framework keyword identities', () => {
  const result = useFixture(
    'csharp-framework-heritage',
    {
      'Aliases.cs': `#nullable enable
namespace Model { public class Box<A> {} }
public abstract class ScalarBase<T> {
 public virtual void Direct(T arg) {}
 public virtual void Vector(T[] arg) {}
 public virtual void Boxed(global::Model.Box<T> arg) {}
 public virtual void ByRef(ref T arg) {}
}
public abstract class RootedString : ScalarBase<global::System.String?> {
 public override void Direct(string? arg) {}
 public override void Vector(string?[] arg) {}
 public override void Boxed(global::Model.Box<string?> arg) {}
 public override void ByRef(ref string? arg) {}
}
public abstract class KeywordString : ScalarBase<string?> { public override void Direct(global::System.String? arg) {} }
public abstract class RootedObject : ScalarBase<global::System.Object?> { public override void Direct(object? arg) {} }
public abstract class RootedInt : ScalarBase<global::System.Int32?> { public override void Direct(int? arg) {} }
public abstract class NullValue : ScalarBase<global::System.Int32?> { public override void Direct(int arg) {} }
public abstract class AliasAgainstOther : ScalarBase<global::System.String?> { public override void Direct(object? arg) {} }
public class General { public virtual void Direct(global::System.String? item){} }
public class GeneralChild : General { public override void Direct(string? item){} }`,
    },
    { workerPoolSize: 1 },
  );
  it('compares rooted framework types and nullable annotations through ordinary generic substitutions', () => {
    expectOverrides(result, 'Aliases.cs', {
      RootedString: [
        'ScalarBase.Direct',
        'ScalarBase.Vector',
        'ScalarBase.Boxed',
        'ScalarBase.ByRef',
      ],
      KeywordString: ['ScalarBase.Direct'],
      RootedObject: ['ScalarBase.Direct'],
      RootedInt: ['ScalarBase.Direct'],
      GeneralChild: ['General.Direct'],
    });
  });
});

describe('C# tuple and Nullable return projections', () => {
  const result = useFixture(
    'csharp-structural-returns',
    {
      'Returns.cs': `#nullable enable
namespace Fixture { public class Box<A> {} }
public class ReturnRoot<T> {
 public virtual (int,string) Pair(global::Fixture.Box<(T key,int value)> arg) => default;
 public virtual global::System.ValueTuple<int,string> Explicit(global::Fixture.Box<(T key,int value)> arg) => default;
 public virtual int? Maybe(global::Fixture.Box<(T key,int value)> arg) => default;
 public virtual (int,string)[] Vector(global::Fixture.Box<(T key,int value)> arg) => default!;
 public virtual object[] Refs(global::Fixture.Box<(T key,int value)> arg) => default!;
 public virtual (int x,int y) Named(global::Fixture.Box<(T key,int value)> arg) => default;
 public virtual (int,int,int,int,int,int,int,int) Eight(global::Fixture.Box<(T key,int value)> arg) => default;
 public virtual (int,int)[][] Jagged(global::Fixture.Box<(T key,int value)> arg) => default!;
 public virtual object AsObject(global::Fixture.Box<(T key,int value)> arg) => default!;
}
public class Valid : ReturnRoot<int> {
 public override global::System.ValueTuple<int,string> Pair(global::Fixture.Box<(int key,int value)> arg) => default;
 public override (int,string) Explicit(global::Fixture.Box<(int key,int value)> arg) => default;
 public override global::System.Nullable<int> Maybe(global::Fixture.Box<(int key,int value)> arg) => default;
 public override global::System.ValueTuple<int,string>[] Vector(global::Fixture.Box<(int key,int value)> arg) => default!;
 public override string[] Refs(global::Fixture.Box<(int key,int value)> arg) => default!;
 public override global::System.ValueTuple<int,int> Named(global::Fixture.Box<(int,int)> arg) => default;
 public override global::System.ValueTuple<int,int,int,int,int,int,int,global::System.ValueTuple<int>> Eight(global::Fixture.Box<(int key,int value)> arg) => default;
 public override global::System.ValueTuple<int,int>[][] Jagged(global::Fixture.Box<(int key,int value)> arg) => default!;
 public override global::System.ValueTuple<int,string>[] AsObject(global::Fixture.Box<(int key,int value)> arg) => default!;
}
public class Invalid : ReturnRoot<int> {
 public override global::System.ValueTuple<long,string> Pair(global::Fixture.Box<(int key,int value)> arg) => default;
 public override (int,int) Explicit(global::Fixture.Box<(int key,int value)> arg) => default;
 public override global::System.Nullable<long> Maybe(global::Fixture.Box<(int key,int value)> arg) => default;
 public override global::System.ValueTuple<int,int>[] Vector(global::Fixture.Box<(int key,int value)> arg) => default!;
 public override global::System.ValueTuple<int,string>[] Refs(global::Fixture.Box<(int key,int value)> arg) => default!;
 public override global::System.ValueTuple<int,int> Named(global::Fixture.Box<(int key,int value)> arg) => default;
 public override global::System.ValueTuple<int,int,int,int,int,int,int,global::System.ValueTuple<long>> Eight(global::Fixture.Box<(int key,int value)> arg) => default;
 public override object[] Jagged(global::Fixture.Box<(int key,int value)> arg) => default!;
 public override global::System.ValueTuple<int,string> AsObject(global::Fixture.Box<(int key,int value)> arg) => default;
}`,
    },
    { workerPoolSize: 1 },
  );
  it('preserves tuple names, long tuple tails and array covariance while rejecting incompatible returns', () => {
    expectOverrides(result, 'Returns.cs', {
      Valid: [
        'ReturnRoot.Pair',
        'ReturnRoot.Explicit',
        'ReturnRoot.Maybe',
        'ReturnRoot.Vector',
        'ReturnRoot.Refs',
        'ReturnRoot.AsObject',
        'ReturnRoot.Named',
        'ReturnRoot.Eight',
        'ReturnRoot.Jagged',
      ],
    });
  });
});

describe('C# declarations sharing framework names', () => {
  const result = useFixture(
    'csharp-source-framework-names',
    {
      'Shadow.cs': `#nullable enable
namespace System {
 public class String {}
 public struct Nullable<T> where T:struct {}
 public struct ValueTuple<A,B> { public A Item1; public B Item2; public ValueTuple(A a,B b) { Item1=a; Item2=b; } }
}
public class Parent<T> { public virtual void Put(T p) {} }
public class Local : Parent<global::System.String?> { public override void Put(global::System.String? p) {} }
public class Keyword : Parent<string?> { public override void Put(string? p) {} }
public class Wrong : Parent<global::System.String?> { public override void Put(string? p) {} }
public class Forms {
 public virtual int? Maybe((int a,int b) p) => null;
 public virtual (int,int) Pair((int a,int b) p) => default;
 public virtual global::System.Nullable<int> Other((int a,int b) p) => default;
}
public class Equal : Forms {
 public override int? Maybe((int,int) p) => null;
 public override global::System.ValueTuple<int,int> Pair((int,int) p) => default;
 public override global::System.Nullable<int> Other((int,int) p) => default;
}
public class Changed : Forms {
 public override global::System.Nullable<int> Maybe((int a,int b) p) => default;
 public override int? Other((int a,int b) p) => null;
}`,
    },
    { workerPoolSize: 1 },
  );
  it('binds source declarations before projecting framework aliases', () => {
    expectOverrides(result, 'Shadow.cs', {
      Local: ['Parent.Put'],
      Keyword: ['Parent.Put'],
      Equal: ['Forms.Maybe', 'Forms.Pair', 'Forms.Other'],
    });
  });
});

describe('C# framework type arity', () => {
  const result = useFixture(
    'csharp-framework-arity',
    {
      'Arity.cs': `#nullable enable
namespace System { public class String<T>{} public class Int32<T>{} public class ValueTuple<T>{} public struct Nullable<T,A> where T:struct{} }
public class Mixed<A> { public virtual void Accept(A item){} }
public class NativeString : Mixed<global::System.String?> { public override void Accept(string? item){} }
public class NativeInt : Mixed<global::System.Int32> { public override void Accept(int item){} }
public class Forms {
 public virtual (int,int) Pair((int x,int y) slot) => default;
 public virtual int? Maybe((int x,int y) slot) => null;
}
public class NativeForms: Forms {
 public override global::System.ValueTuple<int,int> Pair((int x,int y) slot) => default;
 public override global::System.Nullable<int> Maybe((int x,int y) slot) => null;
}`,
    },
    { workerPoolSize: 1 },
  );
  it('selects the written framework arity when source defines another arity with the same name', () => {
    expectOverrides(result, 'Arity.cs', {
      NativeString: ['Mixed.Accept'],
      NativeInt: ['Mixed.Accept'],
      NativeForms: ['Forms.Pair', 'Forms.Maybe'],
    });
  });
});

describe('C# verbatim qualified names in generic heritage', () => {
  const result = useFixture(
    'csharp-verbatim-qualified-heritage',
    {
      'Verbatim.cs': `namespace N { public class T {} public class @int {} public class Pair<A, B> {} }
public class Base<T> {
 public virtual void M(global::@N.Pair<global::N.@T, T> value) {}
}
public class Good : Base<int> {
 public override void M(global::@N.Pair<global::N.@T, int> value) {}
}
public class Bad : Base<int> {
 public override void M(global::@N.Pair<global::N.@int, int> value) {}
}`,
    },
    { workerPoolSize: 1 },
  );

  it('substitutes the free formal while preserving the qualified type with the same tail', () => {
    expectOverrides(result, 'Verbatim.cs', { Good: ['Base.M'] });
  });
});
