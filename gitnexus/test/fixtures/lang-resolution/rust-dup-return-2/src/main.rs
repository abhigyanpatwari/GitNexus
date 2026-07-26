mod t_a;
mod t_b;
fn drive() {
    for item in make() {
        item.save();
    }
}
fn main() {}
