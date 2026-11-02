// A HUB module: a file made only of re-exports, the shape
// `ScopeResolver.namespaceExportsIncludeImportedNames` exists for (ghostty's
// `src/terminal/`, tigerbeetle's `stdx`). It declares nothing of its own —
// every name it publishes is a name it imported.
//
// A consumer writes `hub.scale(x)` to CALL through it, and
// `bridge.accessor(hub.scale, …)` to REGISTER through it. Those are the same
// name resolved by the same rule, so they must not disagree.
pub const scale = @import("dom_utils.zig").scale;
pub const DEFAULT_NS = @import("dom_utils.zig").DEFAULT_NS;
