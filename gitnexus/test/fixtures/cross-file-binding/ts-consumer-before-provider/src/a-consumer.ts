// File starts with 'a-' to sort alphabetically before 'b-provider.ts'.
// In the sequential path, this file is processed first. Without the
// two-pass fix, the accumulator wouldn't have b-provider's bindings
// when this file's verifyConstructorBindings runs.
import { getUser } from './b-provider';

export function main() {
  const x = getUser();
  x.save();
}
