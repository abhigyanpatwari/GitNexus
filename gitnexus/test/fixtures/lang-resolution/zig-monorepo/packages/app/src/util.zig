// A second file of the same package reaching the same dependency: membership in
// a build module is the root plus what it reaches, so a file that is not itself
// a module root must resolve the alias too.
const core = @import("core");

pub fn clamp(attempt: u8) u8 {
    return core.retryBudget(attempt);
}
