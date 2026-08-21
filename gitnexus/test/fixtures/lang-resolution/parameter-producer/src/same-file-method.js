import { makeSpike } from './producer.js'

// SAME-FILE COLLISION, free function vs class method.
//
// The second shape of the same defect: `Runner.apply`'s formal owner is the
// bare identifier `apply`, so it collides with the free `apply` on
// (filePath, ownerName, parameterIndex) exactly as a nested function does.
export function apply(input) {
  return input.source
}

export class Runner {
  // Same NAME as the free `apply`. No caller ever passes it a producer.
  apply(input) {
    return input.source
  }
}

export function callApply() {
  const s = makeSpike()
  return apply(s)
}
