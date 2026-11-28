export class Token<
  Equal extends "=" = "=",
  Pair extends 'a,b' = 'a,b',
  Close extends '>' = '>',
  Quote extends 'a\'b,<=>' = 'a\'b,<=>',
  Template extends `kind,=${number}>` = 'kind,=1>',
  Callback extends (value: Pair) => void = (value: Pair) => void,
> {}

export function create() {
  return new Token();
}
