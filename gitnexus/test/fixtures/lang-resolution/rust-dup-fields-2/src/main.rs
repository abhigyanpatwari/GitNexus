mod c_a;
mod c_b;
pub fn load() -> u8 { 0 }
fn use_it() {
    let Config { db } = load();
    db.run();
}
fn main() {}
