import { publish as valueBesideType } from '../compiler-conformance/typescript-module-ownership/direct-mixed.js';
import { publish as runtimeStar } from '../compiler-conformance/typescript-module-ownership/mixed-owners.js';
import { publish as ambiguous } from '../compiler-conformance/typescript-module-ownership/ambiguous.js';
import { publish as reversed } from '../compiler-conformance/typescript-module-ownership/reversed.js';
import * as wrapper from '../compiler-conformance/typescript-module-ownership/wrapped.js';

export function useValueBesideType() { valueBesideType(); }
export function useRuntimeStar() { runtimeStar(); }
export function ambiguousCall() { ambiguous(); }
export function reversedCall() { reversed(); }
export function wrapperDefault() { wrapper.default(); }
