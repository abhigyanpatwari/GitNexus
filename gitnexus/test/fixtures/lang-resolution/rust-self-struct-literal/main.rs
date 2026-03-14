mod models;
use models::User;

fn main() {
    let user = User::blank();
    user.greet();
}
