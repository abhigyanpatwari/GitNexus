mod t_a;
mod t_b;
mod t_c;
use crate::t_b::make as mk;
fn drive() {
    for item in mk() {
        item.save();
    }
}
fn main() {}
