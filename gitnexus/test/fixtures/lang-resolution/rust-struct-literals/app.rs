mod user;
use user::User;

fn process_user(name: String) {
    let user = User { name };
    user.save();
}
