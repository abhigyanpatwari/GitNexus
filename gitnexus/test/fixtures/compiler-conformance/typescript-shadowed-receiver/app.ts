import { Address } from './models';

export const cs: Address = new Address();

export function gTs(cs) {
  cs.saveTs();
}

export function fTs(cs: Address) {
  const inner = (cs) => {
    cs.saveTs();
  };
  cs.saveTs();
}

export function fPlain(cs: Address, items) {
  {
    const cs = items[0];
    cs.saveTs();
  }
}
