import { makeSpike } from './producer.js'

// SHADOWING ARROW PARAMETER.
//
// `readShadowedArrow`'s own `spike` is typed by its caller, but the arrow
// declares its OWN `spike`. An anonymous arrow is dropped by the callable-flow
// collector (it cannot be named), so it emits no `formal` site and nothing
// marks the arrow's scope as binding the name — a walk that stops at the first
// scope carrying a PRODUCER climbs straight past it and types the arrow's
// parameter from the enclosing formal's callers.
//
// The arrow is handed to a LOCAL function rather than to `items.map(...)` on
// purpose: an unresolved call on a built-in would add a `call` drop to the
// receiver-resolution bench, whose gate counts calls only, for a reason that
// has nothing to do with what this fixture is testing.
function pick(fn) {
  return fn
}

export function readShadowedArrow(spike) {
  return pick((spike) => spike.wickRatio)
}

export function callReadShadowedArrow() {
  const s = makeSpike()
  return readShadowedArrow(s)
}
