import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../../src/types/pipeline.js';
import { FIXTURES, getRelationships, getResolutionOutcomes, writeFixtureRepo } from './helpers.js';

function targets(result: PipelineResult, caller: string, method: string): string[] {
  return getRelationships(result, 'CALLS')
    .filter((edge) => edge.source === caller && edge.target === method)
    .map((edge) => edge.rel.targetId)
    .sort();
}

describe('Java imported overloads and declared dispatch bounds', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-java-imported-overloads-'));
  let result: PipelineResult;
  beforeAll(async () => {
    writeFixtureRepo(root, {
      'api/Explicit.java': `package api; public class Explicit {
        public static void pick(Object x) {} public static void shadow(Object x) {}
      }`,
      'api/Demand.java': `package api; public class Demand {
        public static void pick(String x) {} public static void shadow(Object x) {}
      }`,
      'client/Imports.java': `package client; import static api.Explicit.pick;
        import static api.Explicit.shadow; import static api.Demand.*;
        class Imports { void importedPick() { pick("x"); }
          void importedShadow() { shadow("x"); } }`,
      'api/Hidden.java': `package api; class Hidden { public static void hidden() {} }`,
      'client/HiddenUse.java': `package client; import static api.Hidden.hidden;
        class HiddenUse { void inaccessibleOwner() { hidden(); } }`,
      'api/PrivateHost.java': `package api; import static api.PrivateHost.Holder.secret;
        public class PrivateHost { public static class Holder { private static void secret() {} }
          void privateImport() { secret(); } }`,
      'Dispatch.java': `interface Parent { void task(); } interface Child extends Parent {}
        interface StaticAPI {
          static void staticRun() {} private void privateRun() {}
          default void privateBridge() { this.privateRun(); }
        }
        class RuntimeDecoy implements StaticAPI { public void staticRun() {} public void privateRun() {} }
        class ChildImpl implements Child { public void task() {} }
        class OtherImpl implements Parent { public void task() {} }
        class Dispatch {
          void staticDispatch() { StaticAPI.staticRun(); }
          void childDispatch(Child child) { child.task(); }
          void anonymousDispatch() { Child child = new Child() { public void task() {} }; child.task(); }
          void runnableGood() { Runnable r = new Runnable() { public void run() {} public void run(String x) {} }; r.run(); }
          void runnableBad() { Runnable r = new Runnable() { public void run() {} public void run(String x) {} }; r.run("x"); }
        }`,
    });
    result = await runPipelineFromRepo(root, () => {});
  }, 120_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('keeps different-signature demand imports in the overload family', () => {
    expect(targets(result, 'importedPick', 'pick')).toEqual([
      'Method:api/Demand.java:Demand.pick#1',
    ]);
  });
  it('lets a single static import shadow only an identical demand-import signature', () => {
    expect(targets(result, 'importedShadow', 'shadow')).toEqual([
      'Method:api/Explicit.java:Explicit.shadow#1',
    ]);
  });
  it('does not import a public method through an inaccessible owner type', () => {
    expect(targets(result, 'inaccessibleOwner', 'hidden')).toEqual([]);
  });
  it('does not grant nestmate access at a static-import declaration', () => {
    expect(targets(result, 'privateImport', 'secret')).toEqual([]);
  });
  it('retains the original child-interface bound during runtime dispatch', () => {
    const ids = targets(result, 'childDispatch', 'task');
    expect(ids).toContain('Method:Dispatch.java:ChildImpl.task#0');
    expect(ids).not.toContain('Method:Dispatch.java:OtherImpl.task#0');
  });
  it('keeps a known anonymous receiver on its own implementation branch', () => {
    const ids = targets(result, 'anonymousDispatch', 'task');
    expect(ids).toContain('Method:Dispatch.java:Dispatch$1.task#0');
    expect(ids).not.toContain('Method:Dispatch.java:ChildImpl.task#0');
    expect(ids).not.toContain('Method:Dispatch.java:OtherImpl.task#0');
  });
  it('restricts a Runnable receiver to the platform run() signature', () => {
    expect(targets(result, 'runnableGood', 'run')).toEqual([
      'Method:Dispatch.java:Dispatch$2.run#0',
    ]);
    expect(targets(result, 'runnableBad', 'run')).toEqual([]);
  });
  it('does not dispatch static or private interface methods to same-named instance methods', () => {
    expect(targets(result, 'staticDispatch', 'staticRun')).toEqual([
      'Method:Dispatch.java:StaticAPI.staticRun#0',
    ]);
    expect(targets(result, 'privateBridge', 'privateRun')).toEqual([
      'Method:Dispatch.java:StaticAPI.privateRun#0',
    ]);
  });
});

describe('Java JLS overload resolution — issue #3789', () => {
  let original: PipelineResult;
  beforeAll(async () => {
    original = await runPipelineFromRepo(path.join(FIXTURES, 'java-overload-types'), () => {});
  }, 120_000);

  it('retains the original six signatures and their exact direct caller counts', () => {
    const expected: Record<string, number> = {
      'find#1~Collection<Long>': 3,
      'find#1~Long': 1,
      'resolve#1~String': 1,
      'resolve#1~Long': 1,
      'count#1': 2,
      'count#2': 1,
    };
    const calls = getRelationships(original, 'CALLS');
    for (const [signature, count] of Object.entries(expected)) {
      const id = `Method:src/main/java/demo/LookupService.java:LookupService.${signature}`;
      expect(original.graph.getNode(id), signature).toBeDefined();
      expect(
        new Set(calls.filter((edge) => edge.rel.targetId === id).map((edge) => edge.rel.sourceId))
          .size,
        signature,
      ).toBe(count);
    }
  });

  it('selects collection factories without attributing them to the scalar overload', () => {
    for (const caller of ['listOrders', 'settle', 'find']) {
      expect(targets(original, caller, 'find')).toEqual([
        'Method:src/main/java/demo/LookupService.java:LookupService.find#1~Collection<Long>',
      ]);
    }
    expect(
      getResolutionOutcomes(original).filter(
        (outcome) => outcome.kind === 'suppressed' && outcome.reason.startsWith('overload-'),
      ),
    ).toEqual([]);
  });
});

describe('Java compile-time overload families', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-java-overload-jls-'));
  let result: PipelineResult;
  beforeAll(async () => {
    writeFixtureRepo(root, {
      'Cases.java': `
import java.util.*;
class Base { public void inherited(long value) {} public void declared(Object value) {} }
class Derived extends Base {
  public void inherited(Integer value) {}
  public void declared(String value) {}
}
class Intermediate extends Base {}
class Leaf extends Intermediate { public void inherited(Integer value) {} }
class Nest {
  private void nest(Integer value) {} private void nest(long value) {}
  class Inner { void nestedPrivate(Nest outer) { outer.nest(1); } }
}
class StaticInvocation {
  static void staticChoice(Object value) {} void staticChoice(String value) {}
  static void staticUnqualified() { staticChoice("x"); }
  static void staticQualified() { StaticInvocation.staticChoice("x"); }
}
class AccessFilter {
  private void accessFiltered(String value) {} public void accessFiltered(Object value) {}
}
class BaseShadow { String value; }
class OuterShadow { Long value; class InnerShadow extends BaseShadow {
  void shadowPick(String value) {} void shadowPick(Long value) {}
  void inheritedByThis() { shadowPick(this.value); }
  void inheritedImplicit() { shadowPick(value); }
} }
class ForScope { Long item;
  String[] loopSource(String value) { return null; } String[] loopSource(Long value) { return null; }
  void loopBody(String value) {} void loopBody(Long value) {}
  void enhancedForScope() { for (String item : loopSource(item)) { loopBody(item); } }
}
interface API { void dispatch(long value); void dispatch(Integer value); }
interface Generic<T> { void genericDispatch(T value); }
class StringGeneric implements Generic<String> {
  public void genericDispatch(String value) {} public void genericDispatch(Integer value) {}
}
class IntegerGeneric implements Generic<Integer> { public void genericDispatch(Integer value) {} }
interface Left { void preferred(String value); }
interface Right { void preferred(String value); }
abstract class Both implements Left, Right { void preferred(Object value) {} }
class Implementation implements API {
  public void dispatch(long value) {} public void dispatch(Integer value) {}
}
class A { void run() {} A next() { return this; } }
class B { void run() {} B next() { return this; } }
class SubA extends A { void run() {} }
interface Maker { A create(long value); B create(Integer value); }
class MakerImpl implements Maker { public SubA create(long value) { return new SubA(); } public B create(Integer value) { return new B(); } }
class Cases {
  void phase(Integer value) {} void phase(long value) {}
  void boxed(long value) {} void boxed(Number value) {}
  void variable(String... values) {} void variable(Object value) {}
  void empty(Object... values) {} void empty(String... values) {}
  void nullable(String value) {} void nullable(Integer value) {}
  void crossed(String a, Object b) {} void crossed(Object a, String b) {}
  void opaque(String value) {} void opaque(Long value) {}
  void forbidden(Long value) {}
  void array(Object value) {} void array(String[] value) {}
  void dimensions(Object[] value) {} void dimensions(Object value) {}
  void concrete(Collection<Number> value) {} void concrete(Object value) {}
  void poly(Collection<Number> value) {} void poly(Object value) {}
  void polyAmbiguous(List<Number> value) {} void polyAmbiguous(Collection<Integer> value) {}
  void primitiveArray(List<Long> value) {} void primitiveArray(Object value) {}
  B make(Integer value) { return new B(); } A make(long value) { return new A(); }
  A uncertain(String value) { return new A(); } B uncertain(Long value) { return new B(); }
  void dimension(String value) {} void dimension(Object value) {}
  void widening() { phase(1); }
  void refBeforeUnbox(Integer value) { boxed(value); }
  void fixedBeforeVarargs() { variable("x"); }
  void emptyVarargs() { empty(); }
  void nullAmbiguous() { nullable(null); }
  void crossedAmbiguous() { crossed("a", "b"); }
  Object external() { return null; }
  void unknownArgument() { opaque(external()); }
  void knownInapplicable() { forbidden(1); }
  void arraySpecific(String[] value) { array(value); }
  void primitiveDimensions(int[][] value) { dimensions(value); }
  void invariant(List<Long> value) { concrete(value); }
  void targetTyped(Long value) { poly(Arrays.asList(value)); }
  void targetTypedSingleton(Long value) { poly(Collections.singletonList(value)); }
  void polyTie() { polyAmbiguous(Arrays.asList(1)); }
  void primitiveFactory(long[] values) { primitiveArray(Arrays.asList(values)); }
  void inheritedPhase(Derived value) { value.inherited(1); }
  void emptyIntermediate(Leaf value) { value.inherited(1); }
  void declaredReceiver() { Base value = new Derived(); value.declared("x"); }
  void virtualDispatch(API value) { value.dispatch(1); }
  void chain() { make(1).run(); }
  void assignedChain() { var value = make(1); value.run(); }
  void nestedChain() { make(1).next().run(); }
  void unknownAssignment() { var value = uncertain(external()); value.run(); }
  void ambiguousAssignment() { var value = uncertain(null); value.run(); }
  void interfaceReturn(Maker maker) { maker.create(1).run(); }
  void trailingDimension(String value[]) { dimension(value); }
  void equivalentPreferred(Both value) { value.preferred("x"); }
  void genericCall(Generic<String> value) { value.genericDispatch("x"); }
  void inaccessibleAlternate(AccessFilter value) { value.accessFiltered(external()); }
  void accessibleKnown(AccessFilter value) { value.accessFiltered("x"); }
  <T> void genericAny(Generic<T> value, T item) { value.genericDispatch(item); }
}`,
      'api/Service.java': `package api; public interface Service { void select(long value); void select(Integer value); }`,
      'client/Client.java': `package client; class Client { void acrossPackages(api.Service service) { service.select(1); } }`,
      'names/Names.java': `package names; public class Names { public static class Long {} }`,
      'client/StaticType.java': `package client; import static names.Names.Long;
class StaticType { void select(Long value) {} void select(Number value) {} void staticTypeImport() { select(1L); } }`,
      'first/Base.java': `package first; public class Base { void access(String value) {} protected void protectedChoice(Integer value) {} protected void protectedChoice(long value) {} }`,
      'second/Middle.java': `package second; public class Middle extends first.Base {}`,
      'second/ProtectedChild.java': `package second; import first.Base; class ProtectedChild extends Base { void superProtected() { super.protectedChoice(1); } }`,
      'first/Child.java': `package first; class Child extends second.Middle {
 void access(Object value) {} void interruptedPackage() { access("x"); }
 void castBase() { ((Base)this).access("x"); }
}`,
      'shadow/Shadow.java': `package shadow;
class Arrays { static Object asList(long value) { return null; } }
class Long {}
class Shadow {
  void select(java.util.Collection<java.lang.Long> value) {} void select(java.lang.Long value) {}
  void fakeFactory() { select(Arrays.asList(1L)); }
  void scalar(java.lang.Long value) {} void scalar(Long value) {}
  void shadowedBox(Long value) { scalar(value); }
  void generic(java.lang.Long value) {} void generic(Object value) {}
  <Long> void typeParameter(Long value) { generic(value); }
}
class FactoryField {
  Object Arrays;
  void select(java.util.Collection<java.lang.Long> value) {} void select(java.lang.Long value) {}
  void fieldFactory() { select(Arrays.asList(1L)); }
}
class Incomplete extends external.Base {
  void select(java.lang.String value) {} void select(java.lang.Long value) {}
  void inheritedUnknown() { select("x"); }
}
class ObjectOverload {
  void wait(Integer value) {}
  void implicitObject() throws InterruptedException { wait(1); }
}`,
    });
    result = await runPipelineFromRepo(root, () => {});
  }, 120_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it.each([
    ['widening', 'phase', 'Cases.phase#1~long'],
    ['refBeforeUnbox', 'boxed', 'Cases.boxed#1~Number'],
    ['fixedBeforeVarargs', 'variable', 'Cases.variable#1'],
    ['emptyVarargs', 'empty', 'Cases.empty'],
    ['arraySpecific', 'array', 'Cases.array#1~String[]'],
    ['primitiveDimensions', 'dimensions', 'Cases.dimensions#1~Object[]'],
    ['invariant', 'concrete', 'Cases.concrete#1~Object'],
    ['targetTyped', 'poly', 'Cases.poly#1~Collection<Number>'],
    ['targetTypedSingleton', 'poly', 'Cases.poly#1~Collection<Number>'],
    ['primitiveFactory', 'primitiveArray', 'Cases.primitiveArray#1~Object'],
    ['inheritedPhase', 'inherited', 'Base.inherited#1'],
    ['emptyIntermediate', 'inherited', 'Base.inherited#1'],
    ['trailingDimension', 'dimension', 'Cases.dimension#1~Object'],
    ['nestedPrivate', 'nest', 'Nest.nest#1~long'],
    ['accessibleKnown', 'accessFiltered', 'AccessFilter.accessFiltered#1~Object'],
    ['declaredReceiver', 'declared', 'Base.declared#1'],
  ])('%s selects %s by the earliest applicable JLS phase', (caller, method, signature) => {
    expect(targets(result, caller, method)).toEqual([`Method:Cases.java:${signature}`]);
  });

  it.each([
    ['nullAmbiguous', 'nullable', 'ambiguous'],
    ['crossedAmbiguous', 'crossed', 'ambiguous'],
    ['unknownArgument', 'opaque', 'unknown'],
    ['knownInapplicable', 'forbidden', 'inapplicable'],
    ['polyTie', 'polyAmbiguous', 'ambiguous'],
    ['staticUnqualified', 'staticChoice', 'inapplicable'],
    ['staticQualified', 'staticChoice', 'inapplicable'],
  ])('%s preserves a terminal %s outcome', (caller, method, status) => {
    expect(targets(result, caller, method)).toEqual([]);
    expect(getResolutionOutcomes(result)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'suppressed',
          name: method,
          reason: status === 'ambiguous' ? 'member-lookup-ambiguous' : `overload-${status}`,
        }),
      ]),
    );
  });

  it('fans out only the selected interface signature', () => {
    expect(targets(result, 'virtualDispatch', 'dispatch')).toEqual([
      'Method:Cases.java:API.dispatch#1~long',
      'Method:Cases.java:Implementation.dispatch#1~long',
    ]);
  });

  it.each(['inheritedByThis', 'inheritedImplicit'])(
    'uses the inherited field before the enclosing field for %s',
    (caller) => {
      const calls = targets(result, caller, 'shadowPick');
      expect(calls).toHaveLength(1);
      expect(result.graph.getNode(calls[0]!)?.properties.parameterTypes).toEqual(['String']);
    },
  );

  it('uses the field in an enhanced-for iterable and the loop variable in its body', () => {
    expect(targets(result, 'enhancedForScope', 'loopSource')).toEqual([
      'Method:Cases.java:ForScope.loopSource#1~Long',
    ]);
    expect(targets(result, 'enhancedForScope', 'loopBody')).toEqual([
      'Method:Cases.java:ForScope.loopBody#1~String',
    ]);
  });

  it('preserves generic dispatch filtering and matches the grounded signature across implementation overloads', () => {
    expect(targets(result, 'genericCall', 'genericDispatch')).toEqual([
      'Method:Cases.java:Generic.genericDispatch#1',
      'Method:Cases.java:StringGeneric.genericDispatch#1~String',
    ]);
    expect(targets(result, 'genericAny', 'genericDispatch')).toEqual([
      'Method:Cases.java:Generic.genericDispatch#1',
      'Method:Cases.java:IntegerGeneric.genericDispatch#1',
      'Method:Cases.java:StringGeneric.genericDispatch#1~String',
    ]);
  });

  it('selects the String varargs declaration even when legacy variadic graph IDs coincide', () => {
    const lines = readFileSync(path.join(root, 'Cases.java'), 'utf8').split('\n');
    const line = lines.findIndex((text) => text.includes('void empty(String...'));
    const column = lines[line]!.indexOf('void empty(String...');
    expect(getResolutionOutcomes(result)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'resolved',
          name: 'empty',
          targetId: `def:Cases.java#${line + 1}:${column}:Method:empty`,
        }),
      ]),
    );
  });

  it('treats interface methods as public across package boundaries', () => {
    expect(targets(result, 'acrossPackages', 'select')).toEqual([
      'Method:api/Service.java:Service.select#1~long',
    ]);
  });

  it('resolves a source type named Long by identity without assigning wrapper semantics', () => {
    expect(targets(result, 'shadowedBox', 'scalar')).toEqual([
      'Method:shadow/Shadow.java:Shadow.scalar#1~Long',
    ]);
  });

  it('does not re-inherit a package member after an intermediate class in another package', () => {
    expect(targets(result, 'interruptedPackage', 'access')).toEqual([
      'Method:first/Child.java:Child.access#1',
    ]);
    expect(targets(result, 'castBase', 'access')).toEqual(['Method:first/Base.java:Base.access#1']);
  });

  it('permits a protected superclass call from a subclass in another package', () => {
    expect(targets(result, 'superProtected', 'protectedChoice')).toEqual([
      'Method:first/Base.java:Base.protectedChoice#1~long',
    ]);
  });

  it.each([
    ['fakeFactory', 'select'],
    ['fieldFactory', 'select'],
    ['typeParameter', 'generic'],
    ['inheritedUnknown', 'select'],
    ['implicitObject', 'wait'],
    ['staticTypeImport', 'select'],
    ['equivalentPreferred', 'preferred'],
    ['inaccessibleAlternate', 'accessFiltered'],
  ])('records uncertainty for %s without a guessed overload edge', (caller, method) => {
    expect(targets(result, caller, method)).toEqual([]);
    expect(
      getResolutionOutcomes(result).some(
        (outcome) =>
          outcome.kind === 'suppressed' &&
          outcome.name === method &&
          outcome.reason === 'overload-unknown' &&
          outcome.callerId?.includes(`.${caller}#`),
      ),
    ).toBe(true);
  });

  it.each(['chain', 'assignedChain', 'nestedChain'])(
    'uses the selected compile-time return for %s',
    (caller) => {
      expect(targets(result, caller, 'make')).toEqual(['Method:Cases.java:Cases.make#1~long']);
      expect(targets(result, caller, 'run')).toEqual(['Method:Cases.java:A.run#0']);
    },
  );

  it.each(['unknownAssignment', 'ambiguousAssignment'])(
    'does not infer an assignment receiver before selection for %s',
    (caller) => {
      expect(targets(result, caller, 'uncertain')).toEqual([]);
      expect(targets(result, caller, 'run')).toEqual([]);
    },
  );

  it('uses the selected interface declaration return despite a covariant implementation return', () => {
    expect(targets(result, 'interfaceReturn', 'run')).toContain('Method:Cases.java:A.run#0');
    expect(targets(result, 'interfaceReturn', 'run')).not.toContain('Method:Cases.java:B.run#0');
  });
});
