// A1/A5: a plain object literal held by a module const — no class anywhere.
export const exitRules = {
  exitMinAtrMult: 1.5,
  stopAtrMult: 2.0,
};

// A5: property WRITE on a plain object (the "where is this field SET?" case).
export function tightenExit() {
  exitRules.exitMinAtrMult = 3.0;
}

// A1: property READ through the holding variable — receiver IS typeable.
export function readViaVariable() {
  return exitRules.exitMinAtrMult;
}

// A1: property READ through an untyped param (the option-bag case).
export function applyRules(cfg) {
  return cfg.exitMinAtrMult * cfg.stopAtrMult;
}
