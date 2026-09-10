// A container whose NAME collides with `Element.zig`'s `dom_utils` import
// handle, in a file `Element.zig` never imports.
//
// `findClassBindingInScope` does not stop at the scope chain: when its
// `isClassLike` walk misses — and a namespace import binds a Module, not a
// class — it falls back to `scopes.qualifiedNames`, a WORKSPACE-wide index, and
// answers with the unique def of that name. This struct is that unique def. A
// registration written `dom_utils.compare` in `Element.zig` must still bind
// `dom_utils.zig`'s function, not this one: the file said which module it meant.
pub const dom_utils = struct {
    pub fn compare(a: u8, b: u8) u8 {
        return if (a < b) a else b;
    }

    // A callable that exists ONLY here. `dom_utils.zig` has no member of this
    // name, so a registration written `dom_utils.onlyOnDecoy` declines in the
    // namespace channel and falls through to the container channel — where the
    // workspace-wide qualified-name fallback answers with this struct. The
    // owner-shadow guard is the only thing standing between that and a
    // confident edge into a file `Element.zig` never imported.
    pub fn onlyOnDecoy(v: u8) u8 {
        return v;
    }
};
