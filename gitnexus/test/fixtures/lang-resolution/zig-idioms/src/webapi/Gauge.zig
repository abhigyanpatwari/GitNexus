// The unique workspace definition of the name `Gauge`. `Element.zig` never
// imports it, and declares a module-local `const Gauge` of its own — see
// `readsThroughAShadowedContainerName` there.
const Gauge = @This();

_level: u8 = 0,

pub fn read(self: *Gauge) u8 {
    return self._level;
}
