const c = @cImport({
    @cInclude("api.h");
});

pub fn call() c_int {
    return c.compute(1);
}
