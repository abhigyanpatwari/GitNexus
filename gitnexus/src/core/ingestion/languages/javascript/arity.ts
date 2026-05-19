/**
 * Arity compatibility for JavaScript.
 *
 * Delegates to `typescriptArityCompatibility` unchanged — JavaScript
 * supports the same arity constructs (rest parameters `...args`, default
 * parameters `p = v`) and the metadata shape (`parameterCount`,
 * `requiredParameterCount`, `parameterTypes`) is synthesized by the same
 * `computeTsArityMetadata` function (which understands both TS and JS
 * parameter node types via `extractTsJsParameters`).
 */

export { typescriptArityCompatibility as jsArityCompatibility } from '../typescript/arity.js';
