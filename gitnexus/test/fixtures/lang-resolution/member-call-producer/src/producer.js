// THREE producers owning a `secretFlag`, so resolving to the wrong one is a
// detectable failure rather than a coin flip that happens to look right.
export class SignalService {
  make() {
    return { secretFlag: 'from-make', wickRatio: 0.5 }
  }

  other() {
    return { secretFlag: 'from-other' }
  }
}

// The free-function control. This already resolves (R3-5) and must keep doing so.
export function makeSignal() {
  return { secretFlag: 'from-free', wickRatio: 0.9 }
}
