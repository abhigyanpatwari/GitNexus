// The JS-API binding-table idiom, as Lightpanda writes it (#3399).
//
// Every accessor below hands a Zig function to `bridge.accessor` AS A VALUE:
// the function is REGISTERED here, never called here. The eventual invocation
// runs through comptime reflection (`@call(.auto, func, args)` over a
// `func: anytype` field), which no static walk can follow — that terminal hop
// is out of scope. What was NOT acceptable is dropping the reference entirely:
// `impact` then reported the accessor as having only its two in-file callers
// and called that answer `exact`.
//
// A file-as-struct, like every webapi module in the real tree.
const Element = @This();

_namespace: u8 = 0,

// ── Registered accessors ────────────────────────────────────────────────────

pub fn getNamespaceUri(self: *Element) u8 {
    return self._namespace;
}

// An ordinary in-file caller. The point of the defect is that the REGISTRATION
// was missing, not that the symbol looked like a leaf: a plausible-but-short
// caller list is exactly what makes `epistemic: "exact"` dangerous.
pub fn lookupNamespaceUri(self: *Element) u8 {
    return self.getNamespaceUri();
}

// ── The control ─────────────────────────────────────────────────────────────

// Called normally and registered NOWHERE. Its edges must not move: a change
// that hedges or re-links every method would be indistinguishable from one
// that models value references, and only the second is correct.
pub fn getTagNameLower(self: *Element) u8 {
    return self._namespace;
}

pub fn describe(self: *Element) u8 {
    return self.getTagNameLower();
}

// ── Owner discrimination ────────────────────────────────────────────────────

// Shadowed below by a same-named sibling inside `JsApi`. The registration
// writes `Element.getLocalName`, so THIS is the one it must bind.
pub fn getLocalName(self: *Element) u8 {
    return self._namespace;
}

fn tick(self: *Element) u8 {
    return self._namespace;
}

// ── The binding table ───────────────────────────────────────────────────────

pub const JsApi = struct {
    pub const bridge = Bridge(Element);

    // QUALIFIED value reference — the accessor names its container explicitly.
    // This is the exact line from Element.zig:2296 that #3399 was filed over.
    pub const namespaceURI = bridge.accessor(Element.getNamespaceUri, null, .{});

    // BARE value reference to a sibling declared in this same container.
    pub const tagName = bridge.accessor(_tagName, null, .{});

    fn _tagName(self: *Element) u8 {
        return self.getTagNameLower();
    }

    // A sibling with the SAME simple name as the file-struct method above.
    // `walkScopeChain` gives a local binding precedence over the enclosing
    // scope, so a registration resolved by TAIL NAME alone binds here — the
    // wrong function, silently. Resolving `Element.getLocalName` through its
    // written owner is what keeps them apart.
    fn getLocalName(self: *Element) u8 {
        return 0;
    }

    pub const localName = bridge.accessor(Element.getLocalName, null, .{});

    // A receiver this index cannot resolve. There is a file-level `tick`, and
    // tail-name resolution would happily bind it even though the source says
    // the function belongs to something else entirely. Declining is the only
    // safe answer: a missing reference is recoverable, a confident wrong edge
    // is not.
    pub const ticker = bridge.accessor(unresolvable_ns.tick, null, .{});
};

// ── Const binding initialiser ───────────────────────────────────────────────

fn onReset(self: *Element) u8 {
    return self._namespace;
}

// A `const` whose initialiser IS a function value. Second value position, same
// class of drop.
pub const defaultHandler = onReset;

// ── comptime anytype sink ───────────────────────────────────────────────────

var registered: ?*const fn (*Element) u8 = null;

// Takes a callable by value into a `comptime … anytype` parameter and STORES
// it. Nothing in this file calls `f`.
pub fn register(comptime f: anytype) void {
    registered = f;
}

fn onTick(self: *Element) u8 {
    return self._namespace;
}

pub fn boot() void {
    // `onTick` is never called in this file — it is handed over as a value and
    // invoked later through `registered`.
    register(onTick);
}

fn Bridge(comptime T: type) type {
    _ = T;
    return struct {
        pub fn accessor(comptime getter: anytype, comptime setter: anytype, comptime opts: anytype) u8 {
            _ = getter;
            _ = setter;
            _ = opts;
            return 0;
        }
    };
}
