pub const State = enum { idle, working };

pub const Tag = union(enum) {
    none,
    energy: u32,

    pub fn isEnergy(self: Tag) bool {
        return self == .energy;
    }
};

pub const Pioneer = struct {
    energy: u32,

    pub fn tick(self: *Pioneer) void {
        self.energy += 1;
    }

    pub fn reset(self: *Pioneer) void {
        self.energy = 0;
    }
};
