pub fn area(w: u32, h: u32) u32 {
    return w * h;
}
pub const Point = struct {
    x: i32 = 0,
    pub fn shift(self: *Point, dx: i32) void {
        self.x += dx;
    }
};
