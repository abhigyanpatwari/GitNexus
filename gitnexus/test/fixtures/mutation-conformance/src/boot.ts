// Stryker disable all
// Conformance fixture (gate 2): a module whose mutated form throws while it is imported.

function requireMode(mode: string): string {
  if (mode === '') throw new Error('boot: the mode must not be empty');
  return mode;
}

// Stryker restore next-line StringLiteral
export const BOOT_MODE = requireMode('strict');
