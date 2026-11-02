// A file-struct hosting ANONYMOUS containers (F8):
//   - `std.sort.pdq(T, items, {}, struct { fn lessThan … }.lessThan)` — the
//     comparator idiom (Lightpanda's ImportMap.zig has three in one file, all
//     named `lessThan`: one ownerless `Method:…:lessThan` node for all three);
//   - `const byteSize = struct { fn it … }.it;` — build.zig's shape;
//   - a field typed `?struct { min: u32, max: u32 }`.
// Each gets an identity (`Sorter.sortBoth$1`, `Sorter.sortBoth$2`,
// `Sorter$1`, `Sorter$2`) so its fns are Methods WITH an owner and never
// collide.
const std = @import("std");
const Sorter = @This();

items: []u32,
bounds: ?struct { min: u32, max: u32 } = null,

const byteSize = struct {
    fn it(n: u32) bool {
        return before(n, n);
    }
}.it;

pub fn sortBoth(self: *Sorter) void {
    std.sort.pdq(u32, self.items, {}, struct {
        fn lessThan(_: void, a: u32, b: u32) bool {
            return before(a, b);
        }
    }.lessThan);
    std.sort.pdq(u32, self.items, {}, struct {
        fn lessThan(_: void, a: u32, b: u32) bool {
            return before(b, a);
        }
    }.lessThan);
}

fn before(a: u32, b: u32) bool {
    return a < b;
}

// A container local to a TEST block (Function.zig / HttpClient.zig tests
// declare a `const State = struct {…}` per test): host is the quoted test name.
test "Sorter: local state" {
    const State = struct {
        n: u32 = 0,
        fn kill(self: *@This()) void {
            self.n = if (before(self.n, 1)) 1 else 0;
        }
    };
    var state = State{};
    state.kill();
}
