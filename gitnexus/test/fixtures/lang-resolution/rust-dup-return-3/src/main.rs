mod t_a;
mod t_b;
mod t_c;
fn drive() {
    for item in make() {
        item.save();
    }
}
fn main() {}
