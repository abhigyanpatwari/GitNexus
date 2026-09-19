const config = @import("config");
const api = @import("api");

pub fn main() void {
    config.load_app();
    api.ping();
}
