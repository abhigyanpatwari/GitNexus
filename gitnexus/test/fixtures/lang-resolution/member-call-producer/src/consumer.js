import { SignalService, makeSignal } from './producer.js'

export function readFree() {
  const r = makeSignal()
  return r.secretFlag
}

export function readMake() {
  const svc = new SignalService()
  const r = svc.make()
  return r.secretFlag
}

export function readOther() {
  const svc = new SignalService()
  const r = svc.other()
  return r.secretFlag
}

// The member is on NEITHER method's shape — must stay unresolved.
export function readAbsent() {
  const svc = new SignalService()
  const r = svc.make()
  return r.notOnAnyShape
}
