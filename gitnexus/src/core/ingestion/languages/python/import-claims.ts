import type { NameClaim } from 'gitnexus-shared';

export interface PythonImportClaim {
  identity: string;
  packageRoot?: string;
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
    for (const position of positions) {
      const item = claims[position]!;
      // A definite def/class store keeps its own target even when imports
      // sharing its name are uncertain.
      if (definiteDeclarations.has(item)) continue;
      result[position] =
        !compatible || mixed ? { ...item, kind: 'blocked' } : { ...item, merge: true };
    }
  }
  return result;
}
