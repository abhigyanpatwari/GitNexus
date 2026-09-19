// A NAMESPACE file: no top-level fields, so it is not a type. `const util =
// @This();` here is a plain Const (nothing to alias), `helper` stays a
// top-level Function, and `util.helper()` is a namespace-member call.
const util = @This();

pub fn helper() u32 {
    return 1;
}
