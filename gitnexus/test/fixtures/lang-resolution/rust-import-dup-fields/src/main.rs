mod t_a;
mod t_b;
mod t_c;
use crate::t_b::Config;
pub fn load() -> u8 { 0 }
fn use_it() {
    let Config { db } = load();
    db.run();
}
fn main() {}
