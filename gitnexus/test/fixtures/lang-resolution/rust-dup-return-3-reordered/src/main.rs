mod z_user;
mod m_repo;
mod a_task;
fn drive() {
    for item in make() {
        item.save();
    }
}
fn main() {}
