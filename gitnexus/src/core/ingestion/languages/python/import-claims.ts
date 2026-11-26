import type { NameClaim } from 'gitnexus-shared';

export interface PythonImportClaim {
  identity: string;
  packageRoot?: string;
  /** The source-side name a named or aliased import binds (`f` in
   * `from m import f as g`); absent for module imports. */
  importedName?: string;
  claim: NameClaim;
}

export function reconcilePythonImportClaims(
  claims: NameClaim[],
  importsByName: ReadonlyMap<string, readonly PythonImportClaim[]>,
  definiteDeclarations: ReadonlySet<NameClaim>,
): NameClaim[] {
  if (importsByName.size === 0) return claims;
  // Index positions to preserve capture order and the identity of untouched
  // claims. Each claim and import record is examined a bounded number of times.
  const positionsByName = new Map<string, number[]>();
  for (let i = 0; i < claims.length; i++) {
    const item = claims[i]!;
    const name = item.name;
    if (item.redirect !== undefined || !importsByName.has(name)) continue;
    const positions = positionsByName.get(name);
    if (positions === undefined) positionsByName.set(name, [i]);
    else positions.push(i);
  }
  const result = [...claims];
  for (const [name, imports] of importsByName) {
    const positions = positionsByName.get(name);
    if (positions === undefined) continue;
    const first = imports[0]!;
    const compatible = imports.every(
      (imp) =>
        imp.identity === first.identity ||
        (first.packageRoot !== undefined && imp.packageRoot === first.packageRoot),
    );
    const importedClaims = new Set(imports.map((imp) => imp.claim));
    const mixed = positions.some((position) => !importedClaims.has(claims[position]!));
    // An aliased import binds the local name to a different source name. A
    // blocked call must also count against that name, or a query on the
    // imported symbol still reads an exact zero.
    const competingTargets = [
      ...new Set(
        imports.flatMap((imp) =>
          imp.importedName !== undefined && imp.importedName !== name ? [imp.importedName] : [],
        ),
      ),
    ];
    for (const position of positions) {
      const item = claims[position]!;
      // A definite def/class store keeps its own target even when imports
      // sharing its name are uncertain.
      if (definiteDeclarations.has(item)) continue;
      result[position] =
        !compatible || mixed
          ? {
              ...item,
              kind: 'blocked',
              competing: true,
              ...(competingTargets.length > 0 ? { competingTargets } : {}),
            }
          : { ...item, merge: true };
    }
  }
  return result;
}
