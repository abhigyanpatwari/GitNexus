import { makeSpike, makeCandle } from './producer.js'

// The W2-2 shape: a bare parameter receiver, typed only by what callers pass.
export function readSpike(spike) {
  return spike.wickRatio
}

export function callReadSpike() {
  const s = makeSpike()
  return readSpike(s)
}

// AMBIGUOUS: two callers passing different producers. Must resolve to NEITHER.
export function readEither(thing) {
  return thing.wickRatio
}

export function callEitherA() {
  const a = makeSpike()
  return readEither(a)
}

export function callEitherB() {
  const b = makeCandle()
  return readEither(b)
}

// A parameter nobody calls with a typed argument — stays unresolved.
export function readUncalled(mystery) {
  return mystery.wickRatio
}

// TWO parameters: only the SECOND is a typed producer, so a rule that ignored
// the parameter index would type `first` from the wrong argument.
export function readSecond(first, second) {
  return second.wickRatio
}

export function callReadSecond() {
  const c = makeCandle()
  return readSecond(1, c)
}
