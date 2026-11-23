import { decodeIdentifierEscapes } from '../../utils/ecmascript-literals.js';

/** Decode ECMAScript identifier escapes without changing written graph identities. */
export const canonicalTypeScriptName = (name: string): string => decodeIdentifierEscapes(name);

export { canonicalModuleExportName } from '../../utils/ecmascript-literals.js';
