// A JS-API module: only ever referenced from the registration table in
// main.zig (`Interfaces = .{ @import("webapi/AbortController.zig"), … }`),
// never bound to a `const`.
pub const JsApi = struct {
    pub const bridge = struct {
        pub const name = "AbortController";
    };
};
