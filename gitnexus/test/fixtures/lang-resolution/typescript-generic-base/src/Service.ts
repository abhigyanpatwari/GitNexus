import { Box } from './Box';
import { IFoo } from './IFoo';

export class Service extends Box<string> implements IFoo<string> {
  foo(t: string): void {}
}
