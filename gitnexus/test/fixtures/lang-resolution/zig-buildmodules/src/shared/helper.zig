// Neither module root: "clash" is ambiguous here and must resolve nothing.
const clash = @import("clash");
pub fn use_helper() void {
    clash.hit_a();
}
