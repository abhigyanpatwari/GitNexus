export class SignedKeys {
  [key: number]: Function;
  [-(/* operand */ ((1)))]() {}
  [+((2))]() {}
}

export function callNegative(keys: SignedKeys) {
  keys[-(1)]();
}

export function callPositive(keys: SignedKeys) {
  keys[+((2))]();
}

export function callDynamic(keys: SignedKeys, value: number) {
  keys[-(value)]();
}
