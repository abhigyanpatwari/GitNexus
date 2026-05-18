// Ambient base class — simulates a .d.ts-declared external/library type
// whose body is never seen by the analyzer. Probes whether Step 2 MRO
// lookup can still resolve inherited members on owners that reconcile-
// ownership skipped because they have no parsed body.
export declare class AmbientBase {
  ambientMethod(): string;
}
