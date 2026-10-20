const rp = @import("mod.zig");
const Page = @import("Page.zig");
const page_mod = @import("Page.zig");

pub fn aliasCall() i32 {
    const x = rp.make();
    return x.m();
}

pub fn inlineCall() i32 {
    return rp.make().m();
}

pub fn fileStructCall() u32 {
    const p = Page.init();
    return p.m();
}

pub fn lowercaseFileStructCall() u32 {
    const q = page_mod.init();
    return q.m();
}
