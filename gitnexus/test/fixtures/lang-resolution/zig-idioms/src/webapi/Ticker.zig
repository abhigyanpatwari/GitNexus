// A file-struct in a module `Element.zig` never imports.
//
// Its only job is to be the unique workspace definition of the name `Ticker`,
// so that `findClassBindingInScope`'s qualified-name fallback can reach it from
// a file that has no binding for that name at all. See the
// `shadowsAContainerName` case in `Element.zig`.
const Ticker = @This();

_ticks: u8 = 0,

pub fn fire(self: *Ticker) u8 {
    return self._ticks;
}
