import { makeSpike } from './producer.js'

// CONTROL for the shadowing guard.
//
// The block declares a name, so it IS a scope the walk has to climb through —
// but not the RECEIVER's name, so the read still reaches the enclosing formal
// and must keep its precise edge. A guard that stops at any binding scope
// rather than at one that binds THIS name would silently delete the feature.
export function readThroughBlock(spike) {
  {
    const label = 1
    return label > 0 ? spike.wickRatio : 0
  }
}

export function callReadThroughBlock() {
  const s = makeSpike()
  return readThroughBlock(s)
}
