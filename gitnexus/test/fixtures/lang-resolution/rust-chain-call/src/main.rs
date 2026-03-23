mod models;

use models::user::User;

struct UserService;

impl UserService {
    fn get_user(&self) -> User {
        User { name: String::from("alice") }
    }
}

fn process_user() {
    let svc = UserService;
    svc.get_user().save();
}
