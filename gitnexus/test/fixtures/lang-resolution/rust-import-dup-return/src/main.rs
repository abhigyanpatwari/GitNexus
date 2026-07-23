mod t_a;
mod t_b;
mod t_c;
use crate::t_b::make;
fn drive() {
    for item in make() {
        item.save();
    }
}
fn main() {}
