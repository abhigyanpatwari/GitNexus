mod models;
use models::{User, Config};

fn main() {
    let user = User { name: "alice".to_string(), age: 30 };
    user.save();

    let config = Config { debug: true };
    config.validate();
}
