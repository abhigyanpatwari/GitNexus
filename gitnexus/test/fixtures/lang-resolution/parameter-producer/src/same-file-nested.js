import { makeSpike } from './producer.js'

// SAME-FILE COLLISION, free function vs nested function.
//
// A `formal` site names its owner with a BARE identifier, and one is emitted
// for every parameter of every callable in the file — nested functions
// included. So the free `parse` below and the `parse` nested inside `outer`
// key the formal index identically at parameter 0.
//
// Only the free one is ever called with a typed producer. A last-write-wins
// formal index therefore hands `makeSpike` to the parameter of the callable
// that never received it, and the fabricated edge lands at the 0.9 PRECISE
// tier where no `minConfidence` floor can filter it — while the genuine
// consumer is left untyped. Neither may be typed.
export function parse(row) {
  return row.wickRatio
}

export function callParse() {
  const s = makeSpike()
  return parse(s)
}

export function outer() {
  // Same NAME, different callable. No caller ever passes it a producer.
  function parse(row) {
    return row.wickRatio
  }
  return parse
}
