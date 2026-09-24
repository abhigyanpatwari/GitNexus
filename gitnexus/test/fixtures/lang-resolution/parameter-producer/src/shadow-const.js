import { makeSpike } from './producer.js'

// SHADOWING BLOCK-SCOPED CONST.
//
// The block rebinds `item` to an element of `rows`. The parameter `item` IS
// typed by its caller, so a walk that climbs to the first scope carrying a
// PRODUCER rather than the first scope carrying the NAME reads the block's
// `item` as the caller's producer.
//
// The initializer is a subscript on purpose: `const item = rows` would bind
// `item` to the alias `rows` through the type-binding channel, and the pass
// would decline before the scope walk ever ran — masking the defect instead of
// exercising it.
export function readShadowedConst(item, rows) {
  {
    const item = rows[0]
    return item.wickRatio
  }
}

export function callReadShadowedConst() {
  const s = makeSpike()
  return readShadowedConst(s, [])
}
