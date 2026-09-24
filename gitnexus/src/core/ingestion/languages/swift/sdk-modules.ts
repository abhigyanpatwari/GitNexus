/**
 * Well-known Apple / Swift SDK module names that must not bind to a
 * same-named in-repo folder on the no-manifest path (#2964).
 *
 * Modeled on `CSHARP_EXTERNAL_ROOTS`. A Package.swift target that uses
 * one of these names still wins — this set is only the inferred/null path.
 */
export const SWIFT_SDK_MODULES: ReadonlySet<string> = new Set([
  'Foundation',
  'UIKit',
  'SwiftUI',
  'AppKit',
  'Combine',
  'Dispatch',
  'Darwin',
  'ObjectiveC',
  'Swift',
  'CoreFoundation',
  'CoreData',
  'CoreGraphics',
  'XCTest',
  'Testing',
  'Observation',
  'os',
]);

export function isSwiftSdkModule(name: string): boolean {
  return SWIFT_SDK_MODULES.has(name);
}
