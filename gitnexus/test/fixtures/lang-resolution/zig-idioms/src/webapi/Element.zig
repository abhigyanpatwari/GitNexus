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

// A NAMESPACE-only module (no `@This()`), imported under a handle. The bridge
// table below registers one of its functions the same way it registers this
// file's own methods.
const dom_utils = @import("dom_utils.zig");

// A hub module that re-exports `dom_utils`' members without declaring any.
const hub = @import("hub.zig");

// A MODULE-LEVEL binding whose name collides with the container `Gauge.zig`
// declares, bound to something that is NOT a container. This file never imports
// `Gauge.zig`. `findClassBindingInScope` filters the scope chain by
// `isClassLike`, so it walks past this binding, and its workspace-wide
// qualified-name fallback answers with the other file's struct — while the
// shadow guard used to permit exactly this, treating the module scope as a floor
// it need not inspect.
//
// The name is bound by IMPORT rather than by a local `const Gauge: u8 = 3`,
// and that detail is the difference between a live case and a self-defeating
// one: a local declaration would also claim the workspace qualified name
// `Gauge`, leaving two candidates, and the fallback refuses to guess between
// two. An imported alias claims nothing, so the fallback stays unique and fires.
const Gauge = @import("dom_utils.zig").DEFAULT_NS;

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

    // QUALIFIED value reference through a MODULE handle rather than a container.
    // `dom_utils` is a namespace, not a class, so the class-owner lookup answers
    // nothing here — and declining would be silent rather than safe: with no
    // USES edge, `impact` on `compare` measures a real zero and reports `exact`,
    // which is the claim this whole change exists to stop making.
    pub const comparator = bridge.accessor(dom_utils.compare, null, .{});

    // A namespace member that is NOT callable. Module receivers get the same
    // callable gate as container receivers — a registration table full of
    // constants must keep emitting nothing.
    pub const defaultNs = bridge.accessor(dom_utils.DEFAULT_NS, null, .{});

    // The receiver IS a known namespace import, but `dom_utils.zig` declares no
    // `onlyOnDecoy` — so the namespace channel declines and the container
    // channel runs, reaching `decoy.zig`'s same-named struct through the
    // workspace-wide qualified-name index. A registration must NOT be minted
    // there: the file wrote which module it meant.
    pub const decoyed = bridge.accessor(dom_utils.onlyOnDecoy, null, .{});

    // Through a HUB, whose published names are all imported ones. The CALL form
    // resolves — `namespaceExportsIncludeImportedNames` is what makes a Zig hub
    // work at all — so the REGISTRATION form has to resolve to the same def, or
    // one name means two things depending on whether it is followed by `(`.
    pub const scaled = bridge.accessor(hub.scale, null, .{});

    // …and the callable gate still applies through the hub.
    pub const hubNs = bridge.accessor(hub.DEFAULT_NS, null, .{});

    // `Gauge` names this file's `const Gauge: u8`, not `Gauge.zig`'s container.
    pub const level = bridge.accessor(Gauge.read, null, .{});
};

// The CALL form of the same hub member, so the two are pinned side by side.
pub fn callsThroughTheHub(v: u8) u8 {
    return hub.scale(v);
}

// A LOCAL declaration shadowing the module handle. `dom_utils` here is a `u8`
// parameter with no member of its own; resolving `dom_utils.normalize` through
// the file-level import would attach the registration to a module the source
// did not name at this site — a wrong edge, the failure the same guard prevents
// on the member-CALL path.
pub fn shadowsTheModuleHandle(dom_utils: u8) u8 {
    register(dom_utils.normalize);
    return dom_utils;
}

// A LOCAL declaration shadowing a CONTAINER name — the class-owner half of the
// same failure. `Ticker` here is a `u8` parameter, and this file neither
// declares nor imports the `Ticker` container that `Ticker.zig` defines.
// `findClassBindingInScope` filters the scope chain by `isClassLike`, so it
// walks straight past the parameter and its qualified-name fallback answers
// with a struct from a file this one never named. Resolving `Ticker.fire`
// through that is a confident edge to a function the source did not write.
pub fn shadowsAContainerName(Ticker: u8) u8 {
    register(Ticker.fire);
    return Ticker;
}

// The positive half of the same guard: here the LOCAL declaration IS the
// container the registration names. A shadow test that only asked "is this name
// bound nearer than the module scope" would answer yes and decline — reading the
// declaration as its own shadow — and this whole class of local container would
// stop registering anything.
pub fn registersALocalContainer() u8 {
    const Local = struct {
        pub fn go() u8 {
            return 3;
        }
    };
    return bridge.accessor(Local.go, null, .{});
}

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
