import { expect, it } from 'vitest';
import { getRelationships, useFixture } from './resolvers/helpers.js';

const result = useFixture('java-annotated-lambda-array', {
  'Main.java': `class Element { void save() {} }
class Marker { void save() {} }
interface ArrayAction { void accept(Element[] values); }
class App {
  void run() {
    ArrayAction action = (Element @p.Marker [] values) -> values[0].save();
  }
}`,
  'p/Marker.java': `package p;
import java.lang.annotation.Target;
import java.lang.annotation.ElementType;
@Target(ElementType.TYPE_USE) public @interface Marker {}`,
});

it('never turns an array type-use annotation into the lambda element owner', () => {
  const targets = getRelationships(result(), 'CALLS')
    .filter((edge) => edge.target === 'save')
    .map((edge) => edge.rel.targetId);
  expect(targets).not.toContain('Method:Main.java:Marker.save#0');
});
