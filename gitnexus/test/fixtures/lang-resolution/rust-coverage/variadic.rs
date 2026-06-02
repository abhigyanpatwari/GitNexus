// F73 — variadic parameter in extern function
extern "C" {
    fn printf(fmt: *const u8, ...);
}
