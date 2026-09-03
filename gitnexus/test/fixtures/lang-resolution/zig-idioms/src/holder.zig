// Field-typed receivers (F5). Lightpanda writes most cross-object calls as
// `self.<field>.<method>()` (`self.session.findFrame…`, `self.counter.incr()`),
// or aliases the field first (`const page = self.page; page.getArena()`).
// The receiver's type is the FIELD's declared type — plain, pointer, optional
// pointer, slice — and lives on the owning container, not in any function.
const Counter = @import("counter.zig").Counter;

pub const Holder = struct {
    counter: Counter,
    ptr: *Counter,
    opt: ?*Counter,
    many: []Counter,

    pub fn viaField(self: *Holder) void {
        self.counter.incr();
        self.ptr.incr();
        // payload capture of an optional field
        if (self.opt) |c| c.incr();
    }

    pub fn viaAlias(self: *Holder) u32 {
        const c = self.counter;
        var p = self.ptr;
        p.twice();
        return c.get();
    }
};
