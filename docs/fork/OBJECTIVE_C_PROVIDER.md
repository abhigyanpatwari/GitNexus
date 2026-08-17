# Objective-C Provider

Status: planned

Implementation note (`objc-provider` branch): a first deterministic provider is wired in and
covered by focused tests, but this document remains `planned` until the full acceptance matrix
is green in CI. The local macOS arm64 grammar smoke and Linux Docker arm64/x64 binding-load
smokes pass; the full repository suite still has unrelated host-environment failures.

## Goal

Add deterministic, symbol-level Objective-C analysis to GitNexus. The first release must support high-confidence code navigation and direct static dependency analysis for `.m`, `.mm`, and Objective-C `.h` files. It must not imply that Objective-C runtime dispatch is fully resolved.

The provider belongs in the existing language-provider and scope-resolution extension points. Shared ingestion code must remain language-agnostic.

## Compatibility contract

- Existing language detection and parsing must remain unchanged.
- A `.h` file must be classified from its content or surrounding context; it cannot be unconditionally claimed by Objective-C because C and C++ also use that extension.
- If Objective-C grammar loading fails, the error must clearly name the missing provider/grammar and cannot corrupt a previously valid index.
- Provider and grammar versions must be stored in index metadata. A version change that can alter node identity or edges requires a full rebuild.
- No LLM participates in parsing, name resolution, or edge creation. Analysis is Tree-sitter plus deterministic static resolution.

## MVP model

The provider must extract and connect:

- Classes, superclasses, protocols, categories, class extensions, properties, ivars, C functions, imports, declarations, and implementations.
- Instance and class methods, preserving their complete multi-part selector.
- Inheritance, protocol conformance, import, declaration/implementation, host-class/category, and statically resolved call relationships.

Stable identity must include enough ownership to distinguish same-named methods. Recommended forms are:

```text
objc:class:<ClassName>
objc:protocol:<ProtocolName>
objc:category:<HostClass>:<CategoryName>
objc:method:<Owner>:-:<selector>
objc:method:<Owner>:+:<selector>
objc:function:<qualified-or-file-scoped-name>
```

For example, `-loadData:completion:` and `+loadData:completion:` are different symbols. A category method remains linked to both its category and host class; querying the host class must expose distributed implementations.

## Resolution policy

Resolution must be conservative. A missing or dynamic target is evidence of uncertainty, not proof that no target exists.

| Receiver case | Required result |
| --- | --- |
| Explicit class name, `self`, or `super` | Resolve when the owner is statically known. |
| Local, parameter, property, or ivar with known static type | Resolve to matching owner and selector. |
| Protocol-typed receiver | Link the protocol method and identify possible implementations as candidates. |
| `id`, `Class`, macros, reflection, `performSelector:`, `NSInvocation`, runtime injection, or unknown type | Store selector/location with `resolution=unresolved`; do not emit a certain call edge. |

The provider should first collect file-local declarations, imports, and types, then resolve across the repository. It must use structured Tree-sitter captures or AST traversal, not regular expressions over source text. Multi-part selectors, block arguments, nullability annotations, generics, macros, and multiline declarations make a regex-only extractor unsafe.

## Imports and incremental correctness

- Resolve quoted project imports against the current directory, configured include roots, and indexed headers. Model framework imports as external-module evidence without downloading SDK source.
- Merge `@interface`, `@implementation`, categories, and extensions across files.
- A changed header, protocol, class declaration, or category invalidates importing and affected implementation/call-resolution state. Incremental output after such a change must match a full rebuild.
- Index metadata must record provider version, grammar version, include/exclude configuration, and parsing options used for resolution.

## Implementation sequence

1. Add and package a pinned Objective-C Tree-sitter grammar; verify macOS arm64 and the production Linux runner can load it.
2. Add language detection for `.m`, `.mm`, and content-classified `.h` files.
3. Implement AST extraction and stable IDs for declarations and definitions.
4. Implement repository-level merge, imports, inheritance, protocol, and category relationships.
5. Add conservative message-send resolution and explicit unresolved evidence.
6. Integrate invalidation, metadata comparison, MCP/CLI output, and fixtures.

## Fixtures and acceptance

Create a minimal Objective-C fixture containing a class, protocol, category, extension, superclass, properties, ivars, C function, imports, multi-part selector, block parameter, `self`, `super`, protocol receiver, and `id` receiver. Use `symodulebridge` as a real integration fixture after the minimal suite is stable.

The acceptance bar is:

- `query "SYModuleCaller"` yields class/method semantic nodes, not only file nodes.
- `context "SYModuleCaller" --file <path>` yields declaration, implementation, imports, and known references.
- Known statically typed message sends create call edges; dynamic sends are marked unresolved.
- Same selector on multiple classes, a category override, and `+` versus `-` methods remain distinct.
- A `.m`, `.h`, protocol, or category edit produces results equivalent to a clean rebuild.
- Generated documentation, dependency directories, and build output are excluded through explicit indexing configuration.

## Non-goals

The MVP does not promise exact runtime type inference for `id` or `instancetype`, reflection, swizzling, arbitrary category replacement, dynamic selector construction, or complete impact analysis across every runtime dispatch path. Tool results must surface confidence and unresolved evidence rather than presenting guesses as certain graph facts.

## Current implementation coverage on `objc-provider`

Implemented in the branch:

- Vendored `tree-sitter-objc` grammar, registered through the existing Tree-sitter loader.
- `.m` and `.mm` language mapping plus content-based `.h` classification so plain C/C++ headers are not unconditionally claimed.
- LanguageProvider extraction for classes, protocols, categories, extensions, methods, properties, ivars, C functions, imports, unresolved message evidence, stable Objective-C qualified names, and provider/grammar metadata.
- ScopeResolver edges for imports, inheritance, protocol conformance, category host membership, implementation evidence, and conservative static message sends.
- Persisted query/context support for Objective-C class and method nodes, including implementation evidence via `DECLARES`.
- Regression tests for grammar loading, `.h` classification, stable identities, conservative calls, metadata feature mismatch, persisted query/context behavior, and incremental-vs-force parity for Objective-C fixture edits.

Known limits before changing this status:

- Linux Docker grammar loading is verified for arm64 and x86-64 Node 22 runners; the published CI matrix still needs to exercise the new grammar before this status changes.
- The first version does not perform full Objective-C runtime dispatch, swizzling, dynamic selector construction, macro expansion, or `id` flow inference.
- Protocol receiver handling records the protocol method and candidate implementation evidence, but candidate implementations are not emitted as certain call edges.
- Objective-C++ `.mm` files are parsed with the Objective-C grammar path for this MVP; deep C++ semantic extraction inside Objective-C++ bodies remains outside this provider.
