// Two producers sharing a field name — the case name inference must refuse and
// the one this pass exists to answer with evidence.
export function makeSpike() {
  return { wickRatio: 0.5, source: 'spike' }
}

export function makeCandle() {
  return { wickRatio: 0.9, source: 'candle' }
}
