export const GUARD_TAINT_LIMITATION =
  'Modeled guards can refine unchanged primitive-string values for reviewed sink uses. Imported and wrapper validators, reassigned values, and unsupported predicates or sink uses remain conservative findings. Declared string types are analysis assumptions, not runtime validation.';
