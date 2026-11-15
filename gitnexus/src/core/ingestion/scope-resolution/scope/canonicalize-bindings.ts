import type {
  BindingRef,
  CallableFlowOperand,
  CallableFlowSite,
  ParsedFile,
  SymbolDefinition,
} from 'gitnexus-shared';
import { indexExportsByName } from 'gitnexus-shared';
import { decodeReceiverChain, encodeReceiverChain } from '../../utils/receiver-chain-codec.js';

/** Normalize lookup spellings while retaining source identities and coordinates. */
export function canonicalizeBindings(
  parsed: ParsedFile,
  canonicalName: (name: string) => string,
): ParsedFile {
  const bindingsOf = (scope: ParsedFile['scopes'][number]) => {
    const bindings = new Map<string, BindingRef[]>();
    for (const [name, values] of scope.bindings) {
      const key = canonicalName(name);
      bindings.set(key, [...(bindings.get(key) ?? []), ...values]);
    }
    return bindings;
  };
  const operand = (value: CallableFlowOperand): CallableFlowOperand => ({
    ...value,
    // Qualified designators retain their written member identity, just like
    // rawQualifiedName on a reference; plain operands are lexical scope keys.
    name: value.qualifiedName ? value.name : canonicalName(value.name),
  });
  const flow = (site: CallableFlowSite): CallableFlowSite => {
    switch (site.kind) {
      case 'seed':
        return {
          ...site,
          destination: operand(site.destination),
          targetName: site.targetQualifiedName ? site.targetName : canonicalName(site.targetName),
        };
      case 'copy':
      case 'alias':
      case 'address':
        return { ...site, source: operand(site.source), destination: operand(site.destination) };
      case 'store':
        return { ...site, source: operand(site.source), pointer: operand(site.pointer) };
      case 'load':
        return { ...site, pointer: operand(site.pointer), destination: operand(site.destination) };
      case 'formal':
        // ownerName joins the written definition/graph identity, not a binding.
        return { ...site, binding: operand(site.binding) };
      case 'argument':
        return {
          ...site,
          source: operand(site.source),
          ...(site.directCalleeName
            ? { directCalleeName: canonicalName(site.directCalleeName) }
            : {}),
        };
      case 'invoke':
        return {
          ...site,
          callee: operand(site.callee),
          ...(site.receiver ? { receiver: operand(site.receiver) } : {}),
        };
    }
  };
  const receiverChain = (value: string): string | undefined => {
    const decoded = decodeReceiverChain(value);
    if (!decoded) return value;
    return encodeReceiverChain(
      canonicalName(decoded.baseReceiverName),
      // Steps join raw member declarations; only the base is a lexical key.
      decoded.steps,
      { truncated: decoded.truncated },
    );
  };
  return {
    ...parsed,
    ...(parsed.callableFlowSites ? { callableFlowSites: parsed.callableFlowSites.map(flow) } : {}),
    ...(parsed.callResultAssignmentSites
      ? {
          callResultAssignmentSites: parsed.callResultAssignmentSites.map((site) => ({
            ...site,
            lhs: canonicalName(site.lhs),
          })),
        }
      : {}),
    scopes: parsed.scopes.map((scope) => ({
      ...scope,
      bindings: bindingsOf(scope),
      lexicalNames: scope.lexicalNames && new Set([...scope.lexicalNames].map(canonicalName)),
      nameClaims: scope.nameClaims?.map((claim) => ({ ...claim, name: canonicalName(claim.name) })),
      typeBindings: new Map(
        [...scope.typeBindings].map(([name, type]) => [
          canonicalName(name),
          {
            ...type,
            rawName: canonicalName(type.rawName),
            ...(type.declaredSpelling
              ? { declaredSpelling: canonicalName(type.declaredSpelling) }
              : {}),
          },
        ]),
      ),
    })),
    parsedImports: parsed.parsedImports.map((entry) => ({
      ...entry,
      ...('localName' in entry ? { localName: canonicalName(entry.localName) } : {}),
      ...('importedName' in entry ? { importedName: canonicalName(entry.importedName) } : {}),
      ...('alias' in entry && entry.alias ? { alias: canonicalName(entry.alias) } : {}),
    })),
    referenceSites: parsed.referenceSites.map((site) => {
      // Member registries use the written declaration name. Receiver bases
      // and free names instead address the canonical lexical binding maps.
      const name =
        site.explicitReceiver || site.callForm === 'member' ? site.name : canonicalName(site.name);
      const receiverName = site.explicitReceiver && canonicalName(site.explicitReceiver.name);
      const chain = site.receiverChain && receiverChain(site.receiverChain);
      // Rename occurrences retain these objects as keys in referenceBindings.
      // A second, already-normalized workspace pass must preserve that identity.
      if (
        name === site.name &&
        receiverName === site.explicitReceiver?.name &&
        chain === site.receiverChain
      )
        return site;
      return {
        ...site,
        name,
        ...(site.receiverChain ? { receiverChain: chain } : {}),
        ...(site.explicitReceiver ? { explicitReceiver: { name: receiverName! } } : {}),
      };
    }),
  };
}

/** Use the same semantic spellings for ordinary indexing and rename planning. */
export function canonicalizeWorkspaceBindings(
  parsedFiles: ParsedFile[],
  canonicalName: (name: string) => string,
): void {
  for (let index = 0; index < parsedFiles.length; index++) {
    parsedFiles[index] = canonicalizeBindings(parsedFiles[index], canonicalName);
  }
}

/** Preserve the default export winner policy while exposing semantic name keys. */
export function canonicalModuleExports(
  parsed: ParsedFile,
  canonicalName: (name: string) => string,
): ReadonlyMap<string, SymbolDefinition> {
  const exports = new Map<string, SymbolDefinition>();
  const ambiguous = new Set<string>();
  for (const [spelling, definition] of indexExportsByName(parsed.localDefs)) {
    const name = canonicalName(spelling);
    const previous = exports.get(name);
    if (previous && previous.nodeId !== definition.nodeId) ambiguous.add(name);
    else exports.set(name, definition);
  }
  for (const name of ambiguous) exports.delete(name);
  return exports;
}
