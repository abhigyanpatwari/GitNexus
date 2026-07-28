mod t_a;
mod t_b;
mod t_c;
use crate::t_b::*;
pub struct Local;
impl Local {
    pub fn save(&self) {}
}
pub fn make() -> Vec<Local> { vec![] }
fn drive() {
    for item in make() {
        item.save();
    }
}
fn main() {}
