import { Derived } from './Derived';

export function run(): void {
  const d = new Derived();
  d.ambientMethod();
}
