import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture } from './resolvers/helpers.js';

const bean = (pkg: string, kind: string, declaration: string) =>
  `package ${pkg}; @org.springframework.stereotype.${kind} public class ${declaration} {}`;

const SERVICE = 'org.springframework.stereotype.Service';
const AUTOWIRED = 'org.springframework.beans.factory.annotation.Autowired';

/**
 * A Lombok constructor with the same signature as a written one is a compile
 * error (Lombok still generates it and never removes the written one). The
 * generated constructor and the sole-constructor deduction are refused, but a
 * written constructor explicitly marked for injection is kept.
 */
describe('Spring constructor injection beside a clashing Lombok constructor (review follow-ups, round 5)', () => {
  const result = useFixture('java-review-followups-r5-spring', {
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
