use crate::b_provider::get_user;

pub fn process() {
    let u = get_user();
    u.save();
}
