/**
 * Ruby's veto on the global-name fallback — see
 * `ScopeResolver.isGlobalNameFallbackPlausible`.
 *
 * Ruby keeps the labeled fallback deliberately: with autoload (Rails' zeitwerk,
 * `ActiveSupport::Dependencies`) a file genuinely can call a method whose
 * defining file it never requires, so "no require" is NOT evidence of
 * impossibility the way it is in Go or Rust.
 *
 * What IS decidable is namespacing — but only for CLASS bodies. A method
 * defined inside a `class` is not callable as a bare `helper()` from another
 * file unless that file names the class somehow (a receiver `Ns.helper`, a
 * subclass declaration, an `include`, a `require`). A method defined inside a
 * `module` body is different in kind: modules exist to be mixed in, and Rails
 * mixes them in for you — every `*Helper` module is included into views and
 * controllers by the framework, and concerns arrive through `included do`
 * hooks — so a bare `format_money()` in a view legitimately reaches
 * `module ApplicationHelper` with no `include`, `require`, or constant
 * anywhere in the caller. Refusing that would delete real edges on exactly the
 * codebase shape Ruby's fallback exists to serve. So module-owned methods stay
 * a LABELED guess, and the refusal targets CLASS-owned methods whose class the
 * caller never names. A top-level method (`ownerId === undefined`) is left
 * alone, since that is the shape autoload actually delivers. When the owner
 * cannot be found or typed (no `parsedFileOf`, owner outside the file set),
 * the question is unanswered and the edge is allowed.
 *
 * "Never names" is read from the caller's own text-visible signals — its
 * `require`/`include`/`extend` targets, and any reference site spelling the
 * namespace's constant. If any of them mentions the namespace, the call is
 * plausible and the labeled edge stands. `require` paths are snake_case
 * (`billing/invoice_service`) while constants are CamelCase
 * (`Billing::InvoiceService`), so the comparison normalizes both sides —
 * without that the `require` branch never matched anything.
 *
 * One more thing a caller file can do without naming the class: INHERIT its
 * way to it. `class UsersController < AdminController` reaches every method
 * `ApplicationController` defines while naming only `AdminController`, and an
 * `include Concern` reaches whatever that concern includes in turn. Neither
 * chain is decidable from one file, so a caller with ANY inheritance or mixin
 * surface (an `inherits` site, an `include`/`extend`/`prepend` marker) is
 * treated as plausible. So is a caller file that DEFINES a module: a module's
 * methods run against whatever class includes the module, and call that class's
 * methods bare — `module PostGuardian; def can_see?; is_staff? ...` reaches
 * `class Guardian#is_staff?` because Guardian includes PostGuardian, a fact the
 * module file never states. What remains refused is the shape Ruby itself
 * rejects: a bare call to a class's method from a file that inherits nothing,
 * mixes in nothing, defines no module, and never spells the class. Measured on
 * discourse@3f71fa15c that is ~1000 refusals, and the sample is what the rule
 * promises: RSpec `before`/`after`/`subject` guessed to serializer methods of
 * the same name, `Gemfile`'s `gem` to `Plugin::Instance#gem`, `routes.rb`'s
 * `get` to `Draft#get` — fabricated callers, every one.
 */

import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { moduleSegments } from '../../scope-resolution/utils/name-fallback-visibility.js';
import { HERITAGE_MARKER_PREFIX } from '../../utils/heritage-marker.js';

/**
 * The namespace segments a candidate's qualified name declares, minus the
 * method itself. `Billing::Invoice#total` / `Billing.Invoice.total` → the
 * `Billing`, `Invoice` constants a caller would have to name.
 */
function namespaceConstantsOf(candidate: SymbolDefinition): readonly string[] {
  const qualified = candidate.qualifiedName;
  if (qualified === undefined || qualified === '') return [];
  const segments = qualified
    .split(/::|\.|#/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  // Drop the trailing method name; what remains is the namespace chain.
  const namespace = segments.slice(0, -1);
  // Only CONSTANTS name a Ruby namespace (upper-case initial). A lower-case
  // segment is a receiver expression, not a namespace a caller can mention.
  return namespace.filter((s) => /^[A-Z]/.test(s));
}

/**
 * `billing/invoice_service` vs `InvoiceService`: a path segment names a
 * constant when, with underscores removed, the two are equal case-insensitively.
 * Zeitwerk's own inflection rule, minus acronym overrides — over-matching here
 * only loses a refusal (the edge stays, labeled), which is the safe direction.
 */
function pathSegmentNamesConstant(segment: string, constant: string): boolean {
  return segment.replace(/_/g, '').toLowerCase() === constant.toLowerCase();
}

function requireReachesConstant(targetRaw: string, constant: string): boolean {
  for (const segment of moduleSegments(targetRaw)) {
    if (pathSegmentNamesConstant(segment, constant)) return true;
  }
  return false;
}

/**
 * The declared kind of the candidate's owner, read from the candidate's own
 * file. Ruby labels `class` bodies `Class` and `module` bodies `Trait`
 * (`query.ts`: "module (labeled Trait for class-like registry lookup)").
 * `undefined` when the owner cannot be found — an unanswered question.
 */
function ownerLabelOf(
  candidate: SymbolDefinition,
  parsedFileOf: ((filePath: string) => ParsedFile | undefined) | undefined,
): string | undefined {
  const ownerId = candidate.ownerId;
  if (ownerId === undefined || parsedFileOf === undefined) return undefined;
  const owner = parsedFileOf(candidate.filePath)?.localDefs.find((d) => d.nodeId === ownerId);
  return owner?.type;
}

/**
 * Calls that rebind `self` for the duration of a block: inside
 * `service.instance_eval do … end` a bare `helper()` is dispatched on
 * `service`, so it legitimately reaches a class-owned method the caller file
 * never names. Detected on the caller's SOURCE TEXT, not the call site — the
 * site does not know which block encloses it — so any file that uses one of
 * these forms keeps its class-owned guesses LABELED rather than refused. Coarse
 * in the safe direction: it loses refusals in that file, never an edge.
 */
const SELF_REBINDING_CALL =
  /\b(?:instance_eval|instance_exec|class_eval|class_exec|module_eval|module_exec)\b/;

export function rubyIsGlobalNameFallbackPlausible(ctx: {
  readonly callerParsed: ParsedFile;
  readonly candidate: SymbolDefinition;
  readonly parsedFileOf?: (filePath: string) => ParsedFile | undefined;
  readonly sourceTextOf?: (filePath: string) => string | undefined;
}): boolean {
  if (ctx.candidate.filePath === ctx.callerParsed.filePath) return true;
  // Top-level method — the autoload shape the fallback exists for.
  if (ctx.candidate.ownerId === undefined) return true;
  // A self-rebinding block anywhere in the caller makes "the class is never
  // named here" no proof of impossibility (see `SELF_REBINDING_CALL`). The
  // pipeline always supplies the source; a missing text is an unanswered
  // question and keeps the labeled edge as well.
  const text = ctx.sourceTextOf?.(ctx.callerParsed.filePath);
  if (text === undefined || SELF_REBINDING_CALL.test(text)) return true;
  // Only a CLASS body makes a bare cross-file call impossible without naming
  // it (see the header). A module owner, or an owner we cannot type, is not a
  // refusal.
  if (ownerLabelOf(ctx.candidate, ctx.parsedFileOf) !== 'Class') return true;

  const constants = namespaceConstantsOf(ctx.candidate);
  // Owned but with no nameable namespace (an anonymous or lower-cased owner):
  // nothing to check, so do not refuse on an unanswered question.
  if (constants.length === 0) return true;

  // Any inheritance or mixin surface in the caller can reach the class
  // transitively (see the header) — not decidable here, so not refused.
  for (const site of ctx.callerParsed.referenceSites) {
    if (site.kind === 'inherits') return true;
  }
  for (const imp of ctx.callerParsed.parsedImports) {
    if (imp.targetRaw.startsWith(HERITAGE_MARKER_PREFIX)) return true;
  }
  // A file that defines a module is a mixin whose methods run inside some
  // including class (see the header). Ruby labels `module` bodies `Trait`.
  for (const def of ctx.callerParsed.localDefs) {
    if (def.type === 'Trait') return true;
  }

  for (const imp of ctx.callerParsed.parsedImports) {
    for (const constant of constants) {
      if (requireReachesConstant(imp.targetRaw, constant)) return true;
      // `include Billing::Invoice` arrives as an import whose LOCAL name is the
      // constant rather than a path. Not every variant carries one.
      if ('localName' in imp && imp.localName === constant) return true;
    }
  }
  // A bare mention of the constant anywhere in the caller (`Billing::Invoice`,
  // `Invoice.new`) is enough to make the namespace present in this file. The
  // qualified spelling is matched SEGMENT-wise on `::` / `.`: `InvoiceService`
  // is not a mention of `Invoice`, and a substring test made it one.
  for (const site of ctx.callerParsed.referenceSites) {
    for (const constant of constants) {
      if (site.name === constant) return true;
      if (
        site.rawQualifiedName !== undefined &&
        site.rawQualifiedName.split(/::|\./).some((segment) => segment === constant)
      ) {
        return true;
      }
    }
  }
  return false;
}
