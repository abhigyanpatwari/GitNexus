
import type { Public } from './local-types-forward.js';
import { hidden, Erased, directValue } from './local-types-forward.js';
import * as localTypes from './local-types.js';
export function useTypeAlias(x: Public) { x.save(); }
export function useDirectValue() { directValue(); }
export function erasedLocalCalls() {
  // The function name is exported only as a type.
  hidden();
  // The alias is exported only as a type.
  Erased();
  // Namespace access cannot recover an erased value.
  localTypes.hidden();
  // The class alias is exported only as a type.
  new localTypes.Public();
  // The imported class alias has no runtime constructor.
  new Public();
}
import { run as forwarded } from './import-forward.js';
import * as via from './import-forward.js';
import { "other object" as quotedNamespace } from './quote-namespace.js';
import { publish as valueBesideType } from './direct-mixed.js';
import { publish as runtimeStar } from './mixed-owners.js';
export function callForwarded() { forwarded(); }
export function callForwardedNamespace() { via.run(); }
export function useForwardedObject() { via.api.publish(); }
export function useForwardedType(v: via.K) { v.save(); }
export function useQuotedNamespace() { quotedNamespace.publish(); }
import { publish as ambiguous } from './ambiguous.js';
import { publish as reversed } from './reversed.js';
import { publish as same } from './same.js';
import { publish as explicit } from './explicit.js';
import { Entity, erased, specifierErased } from './types-forward.js';
import { operations as namespace } from './namespace.js';
import { api } from './namespace-forward.js';
import * as pack from './namespace-forward.js';
import { operations as diamond } from './namespace-diamond.js';
import { publish as erasedStar, Entity as StarEntity } from './type-star.js';
import { types } from './type-namespace.js';
import { publish as mixed } from './mixed.js';
import { publish as cycled } from './cycle-b.js';
import { dual } from './dual-forward.js';
import * as aliases from './default-alias.js';
import * as localAliases from './alias-forward.js';
import * as wrapper from './wrapped.js';

export function sameCall() { same(); }
export function explicitCall() { explicit(); }
export function typedInstance(value: Entity) { value.save(); }
export function erasedCall() {
  // A type-only export cannot be used as a value.
  erased();
  // The per-specifier form also erases the value.
  specifierErased();
}
export function firstNamespace() { namespace.publish(); }
export function forwardedNamespace() { api.default(); }
export function namedDefault() {
  // The default declaration's lexical name is not published.
  api.defaultExport();
}
export function dualDefault() { dual(); }
export function namedAliasOfDefault() { aliases.exposed(); }
export function privateAliasImplementation() {
  // The lexical name was not exported.
  aliases.implementation();
}
export function namedAlias() { localAliases.exposed(); }
export function hiddenLocalName() {
  // Only the alias was exported.
  localAliases.original();
}
export function directPublication() { localAliases.direct(); }
export function additionalPublication() { localAliases.additional(); }
export function wrapperAlias() { wrapper.exposed(); }
export function hiddenWrapperCallback() {
  // The expression's callback name is local to its body.
  wrapper.callback();
}
export function nestedNamespace() { pack.api.publish(); }
export function diamondNamespace() { diamond.publish(); }
export function qualifiedType(value: pack.api.Entity) { value.save(); }
export function spacedQualifiedType(value: pack . api . Entity) { value.save(); }
export function escapedQualifiedType(value: pack.api.\u0045ntity) { value.save(); }
class Unpublished { save() {} }
// The imported module does not export Unpublished.
export function missingQualifiedType(value: pack.api.Unpublished) { value.save(); }
export function typeStarInstance(value: StarEntity) { value.save(); }
export function typeNamespaceInstance(value: types.Entity) { value.save(); }
export function erasedStarCall() {
  // The star is type-only.
  erasedStar();
}
export function erasedNamespaceCall() {
  // The published namespace is type-only.
  types.publish();
}
export function mixedCall() { mixed(); }
export function cycleCall() { cycled(); }
export function privateNamespace() {
  // The target module does not export privateMember.
  namespace.privateMember();
}
