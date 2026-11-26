import { Factory, make as build } from './factory';

export function use(factory: Factory) {
  const fromNumber = build(1);
  const fromString = build('one');
  fromNumber.save();
  fromString.save();

  const fromNumberMethod = factory.make(1);
  const fromStringMethod = factory.make('one');
  fromNumberMethod.save();
  fromStringMethod.save();
}
