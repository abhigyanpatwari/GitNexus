// F6 — the value-flow shapes that bind a local WITHOUT an annotation. Each fn
// is one shape; the CALLS edge out of it (`… → bump`, `… → name`) only exists
// when the local was typed. Lightpanda: `const page = try Page.init(…)`
// (2,551 `try T.f()` sites), `for (self.frames) |*f|`, `if (self.doc) |doc|`,
// `while (it.next()) |node|`, `const el = node.asElement()`.
const Page = @import("Page.zig");
const Session = @import("Session.zig");

// `try` / `catch` / `orelse` / parens around a constructor call — the
// receiver names the type exactly as in the bare `Page.init(…)` shape.
fn viaTry(s: *Session) !void {
    const p = try Page.make(s);
    p.bump();
}
fn viaCatch(s: *Session) void {
    const p = Page.make(s) catch return;
    p.bump();
}
fn viaOrelse(p: *Page) void {
    const s = p.maybeSession() orelse return;
    _ = s.name();
}
fn viaParens(s: *Session) !void {
    const p = (try Page.make(s));
    p.bump();
}
fn viaTryLiteral(s: *Session) !void {
    const p = try Page{ .session = s };
    p.bump();
}

// A free call: the callee's RETURN type types the local.
fn viaFreeCall() void {
    const p = makeLocal();
    p.bump();
}
fn makeLocal() Page {
    return undefined;
}

// A member call on a fn-local receiver: the METHOD's return type, not the
// receiver's — `s` is a Session, not a Page.
fn viaMemberReturn(p: *Page) void {
    const s = p.getSession();
    _ = s.name();
}

// The same on `self`, inside a container (`const el = self.asElement()`).
const Runner = struct {
    page: *Page,
    pub fn current(self: *Runner) *Page {
        return self.page;
    }
    pub fn go(self: *Runner) void {
        const p = self.current();
        p.bump();
    }
};

// Payload captures.
fn forSlice(pages: []Page) void {
    for (pages) |*p| p.bump();
    for (pages) |p| {
        _ = p.getArena();
    }
}
fn forIndexed(pages: []Page) void {
    for (pages, 0..) |p, i| {
        _ = i;
        p.bump();
    }
}
fn ifOptional(o: ?*Page) void {
    if (o) |p| p.bump();
}
fn ifCallOptional(p: *Page) void {
    if (p.maybeSession()) |s| {
        _ = s.name();
    }
}
fn whileNext(s: *Session) void {
    while (s.next()) |p| p.bump();
}

// One-layer projections bound to a local.
fn viaIndex(pages: []Page) void {
    const p = pages[0];
    p.bump();
}
fn viaUnwrap(o: ?Page) void {
    const p = o.?;
    p.bump();
}
fn viaDeref(ptr: *Page) void {
    const p = ptr.*;
    p.bump();
}

// Guards: nothing typed here, no edge may appear.
fn viaTypeConstructor() void {
    // A TitleCase callee is a type constructor (an alias, F7), not a value.
    const L = List(u8);
    _ = L;
}
fn List(comptime T: type) type {
    return struct {
        x: T,
    };
}
