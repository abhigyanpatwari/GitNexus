// No-body fixture (the KTD6 case). An interface, a type alias, and an abstract
// method have NO CFG body, so they produce ZERO PDG edges. PDG mode cannot
// score these — a bare `impactedCount:0` would read as a confident "safe",
// the exact false-safe impact exists to prevent. The harness EXCLUDES this
// case from PDG scoring (pdgScoring: "exclude"); it exists to assert the
// exclusion path, not to be measured.

export interface Shape {
  area(): number; // criterion: an interface method declaration — no body, no CFG
}

export type ShapeName = 'circle' | 'square';

export abstract class AbstractShape {
  abstract perimeter(): number; // abstract method — no body
}
