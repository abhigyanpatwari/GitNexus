import { makeCandle } from './producer.js'

// A DIFFERENT function that happens to share the name `readSpike`. Its
// parameter must not be typed from the other file's callers, nor answer for
// them — the formal key carries the declaring file for exactly this.
export function readSpike(spike) {
  return spike.source
}

export function callLocalReadSpike() {
  const c = makeCandle()
  return readSpike(c)
}
