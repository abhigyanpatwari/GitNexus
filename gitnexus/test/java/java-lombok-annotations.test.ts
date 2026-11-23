// In-process Lombok annotation identity, generated constructors, and Spring
// constructor injection beside Lombok constructors.
import { describe, expect, it } from 'vitest';
import type { PipelineResult } from '../../src/types/pipeline.js';
import { getRelationships, useFixture } from '../integration/resolvers/helpers.js';

const bean = (pkg: string, kind: string, declaration: string) =>
  `package ${pkg}; @org.springframework.stereotype.${kind} public class ${declaration} {}`;

function lombokMethods(result: PipelineResult, filePath: string): string[] {
  return [...result.graph.iterNodes()]
    .filter((node) => node.properties.synthetic === 'lombok' && node.id.includes(`:${filePath}:`))
    .map((node) => node.id)
    .sort();
}

describe('Java Lombok workspace proof: a statically imported superclass', () => {
  const result = useFixture('java-lombok-static-import', {
    // Holder is in another package: a same-package nested Base is already found
    // by the same-package lookup.
    'q/Holder.java': `package q;
public class Holder {
  public static class Base { public @interface Getter {} }
  public static class Plain { public @interface Marker {} }
}`,
    'p/Model.java': `package p;
import static q.Holder.Base;
import lombok.Getter;
class Model extends Base { @Getter String name; }`,
    'p/Control.java': `package p;
import static q.Holder.Plain;
import lombok.Getter;
class Control extends Plain { @Getter String name; }`,
  });

  it('lets the inherited member annotation type shadow Lombok', () => {
    expect(lombokMethods(result(), 'p/Model.java')).toEqual([]);
  });

  it('still synthesizes when the imported superclass declares no such member type', () => {
    expect(lombokMethods(result(), 'p/Control.java')).toEqual([
      'Method:p/Control.java:Control.getName#0',
    ]);
  });
});

describe('Lombok annotation identity and generated constructors', () => {
  const result = useFixture('java-lombok-annotations', {
    // Item 1: an unrelated second wildcard does not change what lombok.* supplies.
    'i1/Account.java': `package i1; import lombok.*; import java.util.*;
@Data public class Account { private String name; private List<String> tags; }`,
    'i1/Customer.java': `package i1; import javax.persistence.*; import lombok.*;
@Entity @Getter @Setter public class Customer { private String email; }`,
    'i1/Conf.java': `package i1; import lombok.*; import org.springframework.beans.factory.annotation.*;
@Value public class Conf { String url; }`,
    'i1/Other.java': `package i1; public class Other {
  public String getName() { return ""; } public String getEmail() { return ""; } public String getUrl() { return ""; }
}`,
    'i1/Svc.java': `package i1; class Svc {
  void account(Account a) { a.getName(); }
  void customer(Customer c) { c.getEmail(); }
  void conf(Conf c) { c.getUrl(); }
}`,
    // Item 2: library bases add no names; an undecidable base never enables.
    'i2/Ex.java': `package i2; import lombok.*;
public class Ex extends RuntimeException { @Getter private final String code = "x"; }`,
    'i2/Dto.java': `package i2; import lombok.*;
@Data public class Dto implements java.io.Serializable { @Setter(AccessLevel.NONE) private String id; private String name; }`,
    'i2/Holder.java': 'package i2; public class Holder { public static class Inner {} }',
    'i2/Unsure.java': `package i2; import lombok.*;
@Data public class Unsure extends Holder.Inner { @Setter(AccessLevel.NONE) private String id; private String name; }`,
    'i2/GBase.java': 'package i2; public class GBase { public @interface Getter {} }',
    'i2/GModel.java':
      'package i2; import lombok.*; public class GModel extends GBase { @Getter String name; }',
    'i2/Other.java': `package i2; public class Other {
  public String getCode() { return ""; } public void setId(String id) {} public String getName() { return ""; }
}`,
    'i2/Svc.java': `package i2; class Svc {
  void ex(Ex e) { e.getCode(); }
  void dto(Dto d) { d.setId("1"); }
  void unsure(Unsure u) { u.setId("1"); }
  void shadowed(GModel m) { m.getName(); }
}`,
    // Item 3: private member types are not inherited; package access stays in its package.
    'i3p/Base.java': 'package i3p; public class Base { private @interface Getter {} }',
    'i3p/Model.java':
      'package i3p; import lombok.Getter; public class Model extends Base { @Getter String name; }',
    'i3p/PkgBase.java': 'package i3p; public class PkgBase { @interface Getter {} }',
    'i3p/Same.java':
      'package i3p; import lombok.Getter; public class Same extends PkgBase { @Getter String name; }',
    'i3p/Other.java': 'package i3p; public class Other { public String getName() { return ""; } }',
    'i3q/Cross.java':
      'package i3q; import lombok.Getter; public class Cross extends i3p.PkgBase { @Getter String name; }',
    'i3q/Svc.java': `package i3q; class Svc {
  void privateBase(i3p.Model m) { m.getName(); }
  void crossPackage(Cross c) { c.getName(); }
  void samePackage(i3p.Same s) { s.getName(); }
}`,
    // Item 4: a single-static-import of a member type shadows lombok.*.
    'custom4/Tags.java': 'package custom4; public class Tags { public @interface Value {} }',
    'i4/Store4.java': bean('i4', 'Repository', 'Store4'),
    'i4/Consumer.java': `package i4; import lombok.*; import static custom4.Tags.Value;
@org.springframework.stereotype.Service @Value public class Consumer { Store4 repo; }`,
    'i4/Control.java': `package i4; import lombok.*;
@org.springframework.stereotype.Service @Value public class Control { Store4 repo; }`,
    'i4/Caller.java': `package i4; class Caller {
  void consumer(Consumer c) { c.getRepo(); }
  void control(Control c) { c.getRepo(); }
}`,
    // Item 5: FieldDefaults(makeFinal = true) adds final, so initialized fields are not parameters.
    'i5/Helper.java': bean('i5', 'Component', 'Helper'),
    'i5/Audit.java': bean('i5', 'Component', 'Audit'),
    'i5/Clock.java': bean('i5', 'Component', 'Clock'),
    'i5/FieldDefaultsSvc.java': `package i5;
import lombok.AccessLevel; import lombok.AllArgsConstructor; import lombok.experimental.FieldDefaults;
@org.springframework.stereotype.Service @AllArgsConstructor
@FieldDefaults(makeFinal = true, level = AccessLevel.PRIVATE)
public class FieldDefaultsSvc { Helper helper; Audit audit = new Audit(); }`,
    'i5/S.java': `package i5;
import lombok.RequiredArgsConstructor; import lombok.experimental.FieldDefaults;
@org.springframework.stereotype.Service @RequiredArgsConstructor @FieldDefaults(makeFinal = true)
public class S { Clock clock; }`,
    // Item 6: an enum member annotation type shadows lombok.* for nested types.
    'i6/E.java': `package i6; import lombok.*;
public enum E { ; @interface Value {} @Value static class C { String x; } }`,
    'i6/Other.java': 'package i6; public class Other { public String getX() { return ""; } }',
    'i6/Caller.java': 'package i6; class Caller { void f(E.C c) { c.getX(); } }',
    // Item 7: class-level Builder adds no constructor beside a written one.
    'i7/Store7.java': bean('i7', 'Repository', 'Store7'),
    'i7/Other7.java': bean('i7', 'Repository', 'Other7'),
    'i7/BuilderSvc.java': `package i7; import lombok.Builder;
@org.springframework.stereotype.Service @Builder public class BuilderSvc {
  private final Other7 other = null;
  BuilderSvc(Store7 r) {}
}`,
    'i7/BuilderGen.java': `package i7; import lombok.Builder;
@org.springframework.stereotype.Service @Builder public class BuilderGen { Store7 repo; }`,
    // Item 8: a comment between @ and the name still meets the package shadow.
    'i8/Value.java': 'package i8; public @interface Value {}',
    'i8/Model.java': 'package i8; import lombok.*; @/*c*/Value public class Model { String name; }',
    'i8/Other.java': 'package i8; public class Other { public String getName() { return ""; } }',
    'i8/Caller.java': 'package i8; class Caller { void f(Model m) { m.getName(); } }',
  });

  const callTargets = (source: string) =>
    getRelationships(result(), 'CALLS')
      .filter((edge) => edge.rel.sourceId === source)
      .map((edge) => edge.rel.targetId)
      .sort();
  const syntheticIds = () =>
    [...result().graph.iterNodes()]
      .filter((node) => node.properties.synthetic === 'lombok')
      .map((node) => node.id);

  it.each([
    ['i1/Svc.java:Svc.account#1', ['Method:i1/Account.java:Account.getName#0']],
    ['i1/Svc.java:Svc.customer#1', ['Method:i1/Customer.java:Customer.getEmail#0']],
    ['i1/Svc.java:Svc.conf#1', []],
    ['i2/Svc.java:Svc.ex#1', ['Method:i2/Ex.java:Ex.getCode#0']],
    ['i2/Svc.java:Svc.dto#1', []],
    ['i2/Svc.java:Svc.unsure#1', []],
    ['i2/Svc.java:Svc.shadowed#1', []],
    ['i3q/Svc.java:Svc.privateBase#1', ['Method:i3p/Model.java:Model.getName#0']],
    ['i3q/Svc.java:Svc.crossPackage#1', ['Method:i3q/Cross.java:Cross.getName#0']],
    ['i3q/Svc.java:Svc.samePackage#1', []],
    ['i4/Caller.java:Caller.consumer#1', []],
    ['i4/Caller.java:Caller.control#1', ['Method:i4/Control.java:Control.getRepo#0']],
    ['i6/Caller.java:Caller.f#1', []],
    ['i8/Caller.java:Caller.f#1', []],
  ])('resolves accessor calls from %s to the Lombok owner only', (caller, targets) => {
    expect(callTargets(`Method:${caller}`)).toEqual(targets);
  });

  it('keeps every accessor of a Data class beside java.util.*', () => {
    expect(
      syntheticIds()
        .filter((id) => id.startsWith('Method:i1/Account.java:'))
        .sort(),
    ).toEqual([
      'Method:i1/Account.java:Account.getName#0',
      'Method:i1/Account.java:Account.getTags#0',
      'Method:i1/Account.java:Account.setName#1',
      'Method:i1/Account.java:Account.setTags#1',
    ]);
  });

  it('never turns an unproven field-level AccessLevel.NONE into a class-level setter', () => {
    const ids = syntheticIds();
    expect(ids.filter((id) => id.startsWith('Method:i2/Dto.java:')).sort()).toEqual([
      'Method:i2/Dto.java:Dto.getId#0',
      'Method:i2/Dto.java:Dto.getName#0',
      'Method:i2/Dto.java:Dto.setName#1',
    ]);
    expect(ids.filter((id) => id.startsWith('Method:i2/Unsure.java:')).sort()).toEqual([
      'Method:i2/Unsure.java:Unsure.getId#0',
      'Method:i2/Unsure.java:Unsure.getName#0',
      'Method:i2/Unsure.java:Unsure.setName#1',
    ]);
  });

  it('does not synthesize accessors behind a shadowed annotation', () => {
    expect(
      syntheticIds().filter((id) =>
        ['i2/GModel.java', 'i3p/Same.java', 'i4/Consumer.java', 'i6/E.java', 'i8/Model.java'].some(
          (file) => id.startsWith(`Method:${file}:`),
        ),
      ),
    ).toEqual([]);
  });

  it('emits generated-constructor injection only for proven, fully described constructors', () => {
    expect(
      getRelationships(result(), 'INJECTS')
        .map((edge) => `${edge.rel.sourceId}->${edge.rel.targetId}`)
        .sort(),
    ).toEqual([
      'Class:i4/Control.java:Control->Class:i4/Store4.java:Store4',
      'Class:i5/FieldDefaultsSvc.java:FieldDefaultsSvc->Class:i5/Helper.java:Helper',
      'Class:i5/S.java:S->Class:i5/Clock.java:Clock',
      'Class:i7/BuilderGen.java:BuilderGen->Class:i7/Store7.java:Store7',
      'Class:i7/BuilderSvc.java:BuilderSvc->Class:i7/Store7.java:Store7',
    ]);
  });
});

const SERVICE = 'org.springframework.stereotype.Service';
const AUTOWIRED = 'org.springframework.beans.factory.annotation.Autowired';

/**
 * A Lombok constructor with the same signature as a written one is a compile
 * error (Lombok still generates it and never removes the written one). The
 * generated constructor and the sole-constructor deduction are refused, but a
 * written constructor explicitly marked for injection is kept.
 */
describe('Spring constructor injection beside a clashing Lombok constructor', () => {
  const result = useFixture('java-lombok-spring-injection', {
    // c1: @Autowired with a qualifier. The written parameter picks one store;
    // the generated (unqualified) one would have named both.
    'c1/Store1.java': 'package c1; public interface Store1 {}',
    'c1/PrimaryStore1.java': bean('c1', 'Repository("primary")', 'PrimaryStore1 implements Store1'),
    'c1/OtherStore1.java': bean('c1', 'Repository', 'OtherStore1 implements Store1'),
    'c1/ClashAutowired.java': `package c1;
import lombok.AllArgsConstructor;
import ${AUTOWIRED};
import org.springframework.beans.factory.annotation.Qualifier;
@${SERVICE} @AllArgsConstructor public class ClashAutowired {
  Store1 store;
  @Autowired ClashAutowired(@Qualifier("primary") Store1 chosen) {}
}`,
    // c2: jakarta @Inject.
    'c2/Clock2.java': bean('c2', 'Component', 'Clock2'),
    'c2/ClashInject.java': `package c2;
import lombok.AllArgsConstructor;
import jakarta.inject.Inject;
@${SERVICE} @AllArgsConstructor public class ClashInject {
  Clock2 clock;
  @Inject ClashInject(Clock2 chosen) {}
}`,
    // c3: two generated constructors, one clashes. Audit3 is reachable only
    // through the generated all-args constructor.
    'c3/Clock3.java': bean('c3', 'Component', 'Clock3'),
    'c3/Audit3.java': bean('c3', 'Component', 'Audit3'),
    'c3/ClashOfTwo.java': `package c3;
import lombok.AllArgsConstructor;
import lombok.RequiredArgsConstructor;
import ${AUTOWIRED};
@${SERVICE} @RequiredArgsConstructor @AllArgsConstructor public class ClashOfTwo {
  final Clock3 clock;
  Audit3 audit;
  @Autowired ClashOfTwo(Clock3 chosen) { this.clock = chosen; }
}`,
    // c4: the clashing written constructor is not annotated.
    'c4/Clock4.java': bean('c4', 'Component', 'Clock4'),
    'c4/ClashPlain.java': `package c4;
import lombok.AllArgsConstructor;
@${SERVICE} @AllArgsConstructor public class ClashPlain {
  Clock4 clock;
  ClashPlain(Clock4 chosen) {}
}`,
    // n1: no clash; the written @Autowired constructor is used.
    'n1/Clock5.java': bean('n1', 'Component', 'Clock5'),
    'n1/Audit5.java': bean('n1', 'Component', 'Audit5'),
    'n1/NoClashAutowired.java': `package n1;
import lombok.AllArgsConstructor;
import ${AUTOWIRED};
@${SERVICE} @AllArgsConstructor public class NoClashAutowired {
  Clock5 clock;
  @Autowired NoClashAutowired(Clock5 chosen, Audit5 audit) {}
}`,
    // n2: no written constructor; the generated one is the sole constructor.
    'n2/Clock6.java': bean('n2', 'Component', 'Clock6'),
    'n2/NoClashGenerated.java': `package n2;
import lombok.RequiredArgsConstructor;
@${SERVICE} @RequiredArgsConstructor public class NoClashGenerated {
  final Clock6 clock;
}`,
  });

  const injects = (pkg: string) =>
    getRelationships(result(), 'INJECTS')
      .filter((edge) => edge.rel.sourceId.startsWith(`Class:${pkg}/`))
      .map((edge) => `${edge.rel.sourceId}->${edge.rel.targetId} | ${edge.rel.reason}`)
      .sort();

  it.each([
    [
      'c1',
      [
        'Class:c1/ClashAutowired.java:ClashAutowired->Class:c1/PrimaryStore1.java:PrimaryStore1 | Spring DI: @Autowired constructor ClashAutowired parameter chosen: Store1; qualifier "primary"',
      ],
    ],
    [
      'c2',
      [
        'Class:c2/ClashInject.java:ClashInject->Class:c2/Clock2.java:Clock2 | Spring DI: @Inject constructor ClashInject parameter chosen: Clock2',
      ],
    ],
    [
      'c3',
      [
        'Class:c3/ClashOfTwo.java:ClashOfTwo->Class:c3/Clock3.java:Clock3 | Spring DI: @Autowired constructor ClashOfTwo parameter chosen: Clock3',
      ],
    ],
  ])(
    'keeps the written annotated constructor in %s as the only injection site under a clash',
    (pkg, expected) => {
      expect(injects(pkg)).toEqual(expected);
    },
  );

  it('does not inject through an unannotated written constructor that clashes with a generated one', () => {
    expect(injects('c4')).toEqual([]);
  });

  it.each([
    [
      'n1',
      [
        'Class:n1/NoClashAutowired.java:NoClashAutowired->Class:n1/Audit5.java:Audit5 | Spring DI: @Autowired constructor NoClashAutowired parameter audit: Audit5',
        'Class:n1/NoClashAutowired.java:NoClashAutowired->Class:n1/Clock5.java:Clock5 | Spring DI: @Autowired constructor NoClashAutowired parameter chosen: Clock5',
      ],
    ],
    [
      'n2',
      [
        'Class:n2/NoClashGenerated.java:NoClashGenerated->Class:n2/Clock6.java:Clock6 | Spring DI: constructor NoClashGenerated parameter clock: Clock6',
      ],
    ],
  ])('keeps constructor injection in %s unchanged without a clash', (pkg, expected) => {
    expect(injects(pkg)).toEqual(expected);
  });
});
