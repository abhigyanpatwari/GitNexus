import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture } from './resolvers/helpers.js';

describe('Lombok annotation package and type-root ownership', () => {
  const result = useFixture('java-lombok-annotation-package-shadow', {
    'p/Value.java': 'package p; public @interface Value {}',
    'p/Repo.java': 'package p; @org.springframework.stereotype.Repository public class Repo {}',
    'p/Model.java': `package p;
import lombok.*;
@org.springframework.stereotype.Service @Value public class Model { Repo repo; }`,
    'q/lombok.java': 'package q; public class lombok { public @interface Value {} }',
    'q/Model.java': `package q;
@org.springframework.stereotype.Service @lombok.Value public class Model { p.Repo repo; }`,
    'lombok/Placeholder.java': 'package lombok; public class Placeholder {}',
    'org/springframework/stereotype/Service.java':
      'package org.springframework.stereotype; public @interface Service {}',
    'org/springframework/stereotype/Repository.java':
      'package org.springframework.stereotype; public @interface Repository {}',
  });

  it.each(['p', 'q'])('does not synthesize getters for a custom %s.Value annotation', (pkg) => {
    expect([...result().graph.iterNodes()].map((node) => node.id)).not.toContain(
      `Method:${pkg}/Model.java:Model.getRepo#0`,
    );
  });

  it.each(['p', 'q'])('does not invent generated constructor injection for %s.Model', (pkg) => {
    expect(
      getRelationships(result(), 'INJECTS')
        .filter((edge) => edge.rel.sourceId === `Class:${pkg}/Model.java:Model`)
        .map((edge) => edge.rel.targetId),
    ).toEqual([]);
  });
});
