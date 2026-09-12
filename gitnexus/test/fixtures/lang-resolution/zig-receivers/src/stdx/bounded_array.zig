pub fn BoundedArrayType(comptime T: type, comptime capacity: usize) type {
    return struct {
        buffer: [capacity]T = undefined,
        len: usize = 0,
        pub fn count(array: *const @This()) usize {
            return array.len;
        }
    };
}
