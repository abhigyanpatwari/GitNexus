mod factory;
mod models;

use crate::factory::get_user;

pub fn process() {
    let u = get_user();
    u.save();
    u.get_name();
}
