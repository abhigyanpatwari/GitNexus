mod models;
use models::get_user;

fn process_user() {
    let user = get_user("alice");
    user.save();
}
